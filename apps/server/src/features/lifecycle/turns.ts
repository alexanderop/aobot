import {
  type AuditAction,
  type BotId,
  BotPaused,
  ConversationBusy,
  type ConversationId,
  type InitiatorKind,
  PauseNotChanged,
  PauseUnknown,
} from "@aobot/domain";
import {
  Array,
  Context,
  Data,
  Deferred,
  Effect,
  Layer,
  MutableHashMap,
  Option,
  Ref,
  Result,
  Schedule,
  type Schema,
  type Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { AuditLog, type Decision, singleUser } from "../audit/public.ts";
import { PauseStore, type PauseUnreadable } from "./pause-store.ts";

/**
Why a turn ended before its Bot finished: the person pressed Stop, an admin paused its Bot, or this server
could no longer read whether its Bot is paused.
*/
export type StopReason = Data.TaggedEnum<{
  Person: {};
  Paused: {};
  PauseUnknown: {};
}>;

/** Constructors and matchers for {@link StopReason}. */
export const StopReason = Data.taggedEnum<StopReason>();

/** How an audit row says why a turn was stopped, or refused before it started. */
const reasonWords = StopReason.$match({
  Person: () => "stopped by the person",
  Paused: () => "bot paused",
  PauseUnknown: () => "pause state unreadable",
});

/** A conversation claimed for one turn: the signal that stops the turn, and `release`, which frees it early. */
export interface Claim {
  readonly stopped: Deferred.Deferred<StopReason>;
  readonly release: Effect.Effect<void>;
}

/** One turn this server runs: its Bot, and the signal that stops it. */
interface Running {
  readonly bot: BotId;
  readonly stopped: Deferred.Deferred<StopReason>;
}

/**
The Bot turns this server runs, and whether a Bot may run one at all. Every turn starts through
{@link Turns.start}, whoever asked for it, so no turn of a paused Bot starts anywhere.
*/
export class Turns extends Context.Service<
  Turns,
  {
    /**
    Claims `conversation` for one turn of `bot` until the scope closes, then reads whether `bot` is paused.
    A paused Bot is refused with `BotPaused`, and one whose pause cannot be read in three tries with
    `PauseUnknown`: a Bot that may be paused never starts on a guess. Each refusal writes a
    `turn · deny` row and leaves the conversation free.
    */
    readonly start: (
      conversation: ConversationId,
      bot: BotId,
    ) => Effect.Effect<Claim, ConversationBusy | BotPaused | PauseUnknown, Scope.Scope>;
    readonly isRunning: (conversation: ConversationId) => Effect.Effect<boolean>;
    /** The person's Stop: ends the turn running in `conversation`, if one is. */
    readonly stop: (conversation: ConversationId) => Effect.Effect<void>;
    /** Pauses `bot` and stops each of its turns here at once; other servers stop theirs within seconds. */
    readonly pause: (bot: BotId) => Effect.Effect<void, PauseNotChanged>;
    /** Lets `bot`'s turns start again. */
    readonly resume: (bot: BotId) => Effect.Effect<void, PauseNotChanged>;
    /** The paused Bots: once the database has said, then each change. */
    readonly paused: Stream.Stream<ReadonlyArray<BotId>>;
  }
>()("aobot/lifecycle/Turns") {}

/** How often the turns running here are checked against pauses made on another server. */
const checkEvery = "5 seconds";

/**
How many checks in a row may fail to read the pause state before a Bot's turns here are stopped. A turn
never starts on an unreadable pause, but one slow query must not stop every running turn.
*/
const unreadableChecksBeforeStop = 3;

/** A turn's start reads the pause state up to three times, a moment apart, before it refuses. */
const startReads = { times: 2, schedule: Schedule.spaced("100 millis") };

/** Consecutive checks that could not read the pause state, per Bot with a turn running here. */
type Strikes = ReadonlyMap<BotId, number>;

/**
What one check decides from what it read: which Bots' turns stop and why, and the strikes left. A read
that answers clears every strike, and a Bot with no turn running here keeps none.
*/
function judge(
  strikes: Strikes,
  running: ReadonlyArray<BotId>,
  read: Result.Result<ReadonlyArray<BotId>, PauseUnreadable>,
): readonly [Strikes, ReadonlyArray<readonly [BotId, StopReason]>] {
  return Result.match(read, {
    onSuccess: (paused) => [
      new Map(),
      running.flatMap((bot) => (paused.includes(bot) ? [[bot, StopReason.Paused()] as const] : [])),
    ],
    onFailure: () => {
      const counted = running.map((bot) => [bot, (strikes.get(bot) ?? 0) + 1] as const);

      const spent = (failed: number) => failed >= unreadableChecksBeforeStop;

      return [
        new Map(counted.filter(([, failed]) => !spent(failed))),
        counted.flatMap(([bot, failed]) =>
          spent(failed) ? [[bot, StopReason.PauseUnknown()] as const] : [],
        ),
      ];
    },
  });
}

/** Whether two reads name the same Bots, in any order. */
function sameBots(left: ReadonlyArray<BotId>, right: ReadonlyArray<BotId>): boolean {
  return left.length === right.length && left.every((bot) => right.includes(bot));
}

/** {@link Turns} on the app's database, with the check of running turns as a fiber of the layer. */
export const turnsLayer = Layer.effect(
  Turns,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* PauseStore;
    const audit = yield* AuditLog;

    // An entry exists exactly while a turn runs, so this map is also the "one turn per conversation"
    // rule. A restart starts with none.
    const running = MutableHashMap.empty<ConversationId, Running>();

    // None until the first read answers, so the page never shows a guess.
    const known = yield* SubscriptionRef.make(Option.none<ReadonlyArray<BotId>>());

    const strikes = yield* Ref.make<Strikes>(new Map());

    const remember = (paused: ReadonlyArray<BotId>) =>
      SubscriptionRef.set(known, Option.some(paused));

    /** A row on the single user's authority, in the trace that wrote it. */
    const row = (
      initiatorKind: InitiatorKind,
      decision: Decision,
      action: AuditAction,
      detail: Schema.JsonObject,
    ) =>
      Effect.flatMap(Effect.option(Effect.currentSpan), (span) =>
        audit.record({
          traceId: Option.map(span, (current) => current.traceId),
          initiatorKind,
          actorId: singleUser,
          decision,
          action,
          detail,
        }),
      );

    /** The `allow` row of a change and its `succeeded` outcome, for the caller to commit with the change. */
    const changed = (
      initiatorKind: InitiatorKind,
      action: AuditAction,
      detail: Schema.JsonObject,
    ) =>
      row(initiatorKind, "allow", action, detail).pipe(
        Effect.flatMap((allowRow) =>
          audit.recordOutcome({ allowRow, initiatorKind, outcome: "succeeded", detail: {} }),
        ),
      );

    /**
    Stops every turn `which` picks, then records each one it stopped. A stop never waits on the trail, so
    a row that cannot be written is only logged.
    */
    const stopTurns = (
      which: (turn: Running, conversation: ConversationId) => boolean,
      reason: StopReason,
      initiatorKind: InitiatorKind,
    ) =>
      Effect.forEach(
        Array.filter(Array.fromIterable(running), ([conversation, turn]) =>
          which(turn, conversation),
        ),
        ([conversation, turn]) =>
          Deferred.succeed(turn.stopped, reason).pipe(
            Effect.flatMap((first) =>
              first
                ? changed(initiatorKind, "turn.stopped", {
                    bot: turn.bot,
                    conversation,
                    reason: reasonWords(reason),
                  }).pipe(
                    sql.withTransaction,
                    Effect.catch((error) =>
                      Effect.logError("A stopped turn could not be recorded").pipe(
                        Effect.annotateLogs({ bot: turn.bot, reason: error.message }),
                      ),
                    ),
                  )
                : Effect.void,
            ),
          ),
        { discard: true },
      );

    /** Refuses a turn of `bot` with `refusal`, after its `deny` row, which is only logged when it cannot be written. */
    const refuse = (bot: BotId, reason: StopReason, refusal: BotPaused | PauseUnknown) =>
      row("person", "deny", "turn", { bot, reason: reasonWords(reason) }).pipe(
        Effect.catchTag("AuditWriteFailed", (error) =>
          Effect.logError("A refused turn could not be recorded").pipe(
            Effect.annotateLogs({ bot, reason: error.message }),
          ),
        ),
        Effect.andThen(Effect.fail(refusal)),
      );

    const start = Effect.fn("Turns.start")(function* (conversation: ConversationId, bot: BotId) {
      const stopped = yield* Deferred.make<StopReason>();

      // Removes this turn's entry only. By the time a finalizer calls it again, the next turn may
      // already hold the conversation.
      const release = Effect.sync(() => {
        if (
          Option.exists(
            MutableHashMap.get(running, conversation),
            (held) => held.stopped === stopped,
          )
        ) {
          MutableHashMap.remove(running, conversation);
        }
      });

      // The check and the insert run in one synchronous step, so two sends cannot both pass it.
      yield* Effect.acquireRelease(
        Effect.suspend(() =>
          MutableHashMap.has(running, conversation)
            ? Effect.fail(new ConversationBusy({ conversationId: conversation }))
            : Effect.sync(() => MutableHashMap.set(running, conversation, { bot, stopped })),
        ),
        () => release,
      );

      // Read only once the turn is claimed: a pause stored from here on stops it, so none slips
      // between the read and the claim. A refused turn claims nothing.
      yield* store.paused.pipe(
        Effect.retry(startReads),
        Effect.matchEffect({
          onFailure: () => refuse(bot, StopReason.PauseUnknown(), new PauseUnknown({ botId: bot })),
          onSuccess: (paused) =>
            paused.includes(bot)
              ? refuse(bot, StopReason.Paused(), new BotPaused({ botId: bot }))
              : Effect.void,
        }),
        Effect.onError(() => release),
      );

      return { stopped, release };
    });

    const isRunning = (conversation: ConversationId) =>
      Effect.sync(() => MutableHashMap.has(running, conversation));

    const stop = Effect.fn("Turns.stop")(function* (conversation: ConversationId) {
      yield* stopTurns((_, held) => held === conversation, StopReason.Person(), "person");
    });

    /**
    Stores a pause or a resume together with its rows, or neither. One that changes nothing writes no
    row.
    */
    const change = (
      write: Effect.Effect<boolean, SqlError.SqlError>,
      action: "bot.paused" | "bot.resumed",
      bot: BotId,
      notChanged: string,
    ) =>
      write.pipe(
        Effect.flatMap((isChange) => (isChange ? changed("person", action, { bot }) : Effect.void)),
        sql.withTransaction,
        Effect.tapError((error) =>
          Effect.logError("A pause could not be changed").pipe(
            Effect.annotateLogs({ action, bot, reason: error.message }),
          ),
        ),
        Effect.mapError(() => new PauseNotChanged({ message: notChanged })),
        Effect.andThen(store.paused.pipe(Effect.flatMap(remember), Effect.ignore)),
      );

    const pause = Effect.fn("Turns.pause")(function* (bot: BotId) {
      yield* change(
        store.pause(bot, singleUser),
        "bot.paused",
        bot,
        "The Bot was not paused: the pause could not be stored.",
      );
      yield* stopTurns((turn) => turn.bot === bot, StopReason.Paused(), "person");
    });

    const resume = Effect.fn("Turns.resume")(function* (bot: BotId) {
      yield* change(
        store.resume(bot),
        "bot.resumed",
        bot,
        "The Bot was not resumed: the change could not be stored.",
      );
    });

    // Pauses made on another server reach the turns running here through this check.
    const check = Effect.gen(function* () {
      const read = yield* Effect.result(store.paused);

      if (Result.isSuccess(read)) yield* remember(read.success);

      const bots = Array.dedupe(Array.map(Array.fromIterable(running), ([, turn]) => turn.bot));

      const stops = yield* Ref.modify(strikes, (before) => {
        const [after, decided] = judge(before, bots, read);

        return [decided, after];
      });

      yield* Effect.forEach(
        stops,
        ([bot, reason]) =>
          Effect.logWarning("A Bot's turns were stopped by the pause check").pipe(
            Effect.annotateLogs({ bot, reason: reasonWords(reason) }),
            Effect.andThen(stopTurns((turn) => turn.bot === bot, reason, "deployment")),
          ),
        { discard: true },
      );
    });

    // Untraced: a root trace every five seconds would bury the turns.
    yield* check.pipe(
      Effect.repeat(Schedule.spaced(checkEvery)),
      Effect.withTracerEnabled(false),
      Effect.forkScoped,
    );

    const paused = SubscriptionRef.changes(known).pipe(
      Stream.filter(Option.isSome),
      Stream.map((read) => read.value),
      Stream.changesWith(sameBots),
    );

    return Turns.of({ start, isRunning, stop, pause, resume, paused });
  }),
);
