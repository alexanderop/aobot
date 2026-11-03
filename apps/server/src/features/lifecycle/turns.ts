import {
  type AuditAction,
  type BotId,
  BotPaused,
  ConversationBusy,
  type ConversationId,
  InitiatorKind,
  PauseNotChanged,
  PauseUnknown,
  RunErrorCode,
  type RunId,
} from "@aobot/domain";
import {
  Array,
  Context,
  Deferred,
  Effect,
  Layer,
  MutableHashMap,
  Option,
  Ref,
  Result,
  Schedule,
  Schema,
  type Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { auditRows, singleUser } from "../audit/public.ts";
import { PauseStore, type PauseUnreadable } from "./pause-store.ts";

/** Why a turn ends before its Bot finished, as the code of the chat's `RUN_ERROR` names it. */
const StopCode = RunErrorCode.pick(["stopped", "paused", "pause_unknown"]);

type StopCode = typeof StopCode.Type;

/**
The turn was stopped before its Bot finished, for `code`, by `by`: the person, with Stop or a pause on this
server, or the deployment, whose check stops the turns of a Bot paused on another server, or of one whose
pause it can no longer read.
*/
export class TurnStopped extends Schema.TaggedError<TurnStopped>()("TurnStopped", {
  code: StopCode,
  by: InitiatorKind,
}) {}

/** How an audit row says why a turn was stopped, or refused before it started. */
const stopWords: Readonly<Record<StopCode, string>> = {
  stopped: "stopped by the person",
  paused: "bot paused",
  pause_unknown: "pause state unreadable",
};

/** A conversation claimed for one turn. */
interface Claim {
  /** Fails with the {@link TurnStopped} that stopped the turn, once one has. */
  readonly stopped: Deferred.Deferred<never, TurnStopped>;
  /**
  Records that `stop` ended the turn. The turn calls it where the stop becomes its end, so a stop that
  lands after the Bot finished records nothing. Only logged when it cannot be written: the turn ended
  either way.
  */
  readonly recordStop: (stop: TurnStopped) => Effect.Effect<void>;
  /** Frees the conversation before the scope closes. */
  readonly release: Effect.Effect<void>;
}

/** One turn this server runs: its Bot, its run, and the signal that stops it. */
interface Running {
  readonly bot: BotId;
  readonly run: RunId;
  readonly stopped: Deferred.Deferred<never, TurnStopped>;
}

/**
The Bot turns this server runs, and whether a Bot may run one at all. Every turn starts through
{@link Turns.start}, whoever asked for it, so no turn of a paused Bot starts anywhere.
*/
export class Turns extends Context.Service<
  Turns,
  {
    /**
    Claims `conversation` for run `run` of `bot` until the scope closes, then reads whether `bot` is
    paused. A paused Bot is refused with `BotPaused`, and one whose pause cannot be read in three tries
    with `PauseUnknown`: a Bot that may be paused never starts on a guess. Each refusal writes a
    `turn · deny` row and leaves the conversation free.
    */
    readonly start: (
      conversation: ConversationId,
      run: RunId,
      bot: BotId,
    ) => Effect.Effect<Claim, ConversationBusy | BotPaused | PauseUnknown, Scope.Scope>;
    readonly isRunning: (conversation: ConversationId) => Effect.Effect<boolean>;
    /** The person's Stop: stops the turn running in `conversation`, if one is. */
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

/** Consecutive reads of the pause state that failed, per Bot with a turn running here. */
type Strikes = ReadonlyMap<BotId, number>;

/**
What one check decides from what it read: which Bots' turns stop and why, and the strikes left. A read
that answers clears every strike, and a Bot with no turn running here keeps none.
*/
function judge(
  strikes: Strikes,
  running: ReadonlyArray<BotId>,
  read: Result.Result<ReadonlyArray<BotId>, PauseUnreadable>,
): readonly [Strikes, ReadonlyArray<readonly [BotId, StopCode]>] {
  return Result.match(read, {
    onSuccess: (paused) => [
      new Map(),
      running.flatMap((bot) => (paused.includes(bot) ? [[bot, "paused"] as const] : [])),
    ],
    onFailure: () => {
      const counted = running.map((bot) => [bot, (strikes.get(bot) ?? 0) + 1] as const);

      const spent = (failed: number) => failed >= unreadableChecksBeforeStop;

      return [
        new Map(counted.filter(([, failed]) => !spent(failed))),
        counted.flatMap(([bot, failed]) =>
          spent(failed) ? [[bot, "pause_unknown"] as const] : [],
        ),
      ];
    },
  });
}

/** The row each change records. */
const changeActions = {
  pause: "bot.paused",
  resume: "bot.resumed",
} as const satisfies Record<PauseNotChanged["change"], AuditAction>;

/** {@link Turns} on the app's database, with the check of running turns as a fiber of the layer. */
export const turnsLayer = Layer.effect(
  Turns,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* PauseStore;

    const rows = {
      person: yield* auditRows("person"),
      deployment: yield* auditRows("deployment"),
    };

    // An entry exists exactly while a turn runs, so this map is also the "one turn per conversation"
    // rule. A restart starts with none.
    const running = MutableHashMap.empty<ConversationId, Running>();

    // None until the first read answers, so the page never shows a guess.
    const known = yield* SubscriptionRef.make(Option.none<ReadonlyArray<BotId>>());

    const strikes = yield* Ref.make<Strikes>(new Map());

    /**
    Which Bots are paused. A read that answers is shown to the page and clears every strike, so strikes
    count the reads that failed in a row, whoever read.
    */
    const read = store.paused.pipe(
      Effect.tap((paused) =>
        Effect.andThen(
          SubscriptionRef.set(known, Option.some(paused)),
          Ref.set(strikes, new Map()),
        ),
      ),
    );

    /** The turns of `bot` running here. */
    const turnsOf = (bot: BotId) =>
      Effect.sync(() =>
        Array.filter(
          Array.fromIterable(MutableHashMap.values(running)),
          (turn) => turn.bot === bot,
        ),
      );

    /**
    Signals each of `turns` to stop with `stop`. Each turn records the stop where it ends, so a turn that
    finished meanwhile records nothing.
    */
    const stopTurns = (turns: ReadonlyArray<Running>, stop: TurnStopped) =>
      Effect.forEach(turns, (turn) => Deferred.fail(turn.stopped, stop), { discard: true });

    /** The `allow` row of something `by` did at once, and its `succeeded` outcome. */
    const done = (by: InitiatorKind, action: AuditAction, detail: Schema.JsonObject) =>
      rows[by]
        .decide("allow", action, detail)
        .pipe(Effect.flatMap((allowRow) => rows[by].outcome(allowRow, "succeeded", {})));

    const recordStop =
      (conversation: ConversationId, bot: BotId) =>
      (stop: TurnStopped): Effect.Effect<void> =>
        done(stop.by, "turn.stopped", { bot, conversation, reason: stopWords[stop.code] }).pipe(
          sql.withTransaction,
          Effect.catch((error) =>
            Effect.logError("A stopped turn could not be recorded").pipe(
              Effect.annotateLogs({ bot, reason: error.message }),
            ),
          ),
        );

    /** Refuses a turn of `bot` with `refusal`, after its `deny` row. */
    const refuse = (bot: BotId, code: StopCode, refusal: BotPaused | PauseUnknown) =>
      Effect.andThen(
        rows.person.refuse("deny", "turn", { bot, reason: stopWords[code] }),
        Effect.fail(refusal),
      );

    const start = Effect.fn("Turns.start")(function* (
      conversation: ConversationId,
      run: RunId,
      bot: BotId,
    ) {
      const stopped = yield* Deferred.make<never, TurnStopped>();

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
            : Effect.sync(() => MutableHashMap.set(running, conversation, { bot, run, stopped })),
        ),
        () => release,
      );

      // Read only once the turn is claimed: a pause stored from here on stops it, so none slips
      // between the read and the claim. A refused turn claims nothing, and never ran, so a pause that
      // stopped it meanwhile records nothing beside the refusal.
      yield* read.pipe(
        Effect.retry(startReads),
        Effect.matchEffect({
          onFailure: () => refuse(bot, "pause_unknown", new PauseUnknown({ botId: bot })),
          onSuccess: (paused) =>
            paused.includes(bot)
              ? refuse(bot, "paused", new BotPaused({ botId: bot }))
              : Effect.void,
        }),
        Effect.onError(() => release),
      );

      return { stopped, recordStop: recordStop(conversation, bot), release };
    });

    const isRunning = (conversation: ConversationId) =>
      Effect.sync(() => MutableHashMap.has(running, conversation));

    const stop = Effect.fn("Turns.stop")(function* (conversation: ConversationId) {
      yield* stopTurns(
        Option.toArray(MutableHashMap.get(running, conversation)),
        new TurnStopped({ code: "stopped", by: "person" }),
      );
    });

    /**
    Stores a pause or a resume together with its rows, or neither. One that changes nothing writes no
    row.
    */
    const commit = (
      change: PauseNotChanged["change"],
      bot: BotId,
      write: Effect.Effect<boolean, SqlError.SqlError>,
    ) =>
      write.pipe(
        Effect.flatMap((isChange) =>
          isChange ? done("person", changeActions[change], { bot }) : Effect.void,
        ),
        sql.withTransaction,
        Effect.tapError((error) =>
          Effect.logError("A pause could not be changed").pipe(
            Effect.annotateLogs({ change, bot, reason: error.message }),
          ),
        ),
        Effect.mapError(() => new PauseNotChanged({ botId: bot, change })),
      );

    const pause = Effect.fn("Turns.pause")(function* (bot: BotId) {
      // One step, so a pause that was stored has always stopped the turns running here.
      yield* commit("pause", bot, store.pause(bot, singleUser)).pipe(
        Effect.andThen(turnsOf(bot)),
        Effect.flatMap((turns) =>
          stopTurns(turns, new TurnStopped({ code: "paused", by: "person" })),
        ),
        Effect.uninterruptible,
      );
      yield* Effect.ignore(read);
    });

    const resume = Effect.fn("Turns.resume")(function* (bot: BotId) {
      yield* commit("resume", bot, store.resume(bot));
      yield* Effect.ignore(read);
    });

    // Pauses made on another server reach the turns running here through this check.
    const check = Effect.gen(function* () {
      const result = yield* Effect.result(read);

      const bots = Array.dedupe(
        Array.map(Array.fromIterable(MutableHashMap.values(running)), (turn) => turn.bot),
      );

      const stops = yield* Ref.modify(strikes, (before) => {
        const [after, decided] = judge(before, bots, result);

        return [decided, after];
      });

      yield* Effect.forEach(
        stops,
        ([bot, code]) =>
          Effect.logWarning("A Bot's turns were stopped by the pause check").pipe(
            Effect.annotateLogs({ bot, reason: stopWords[code] }),
            Effect.andThen(turnsOf(bot)),
            Effect.flatMap((turns) =>
              stopTurns(turns, new TurnStopped({ code, by: "deployment" })),
            ),
          ),
        { discard: true },
      );
    });

    // Untraced: a root trace every five seconds would bury the turns.
    yield* check.pipe(
      Effect.repeat(Schedule.fixed(checkEvery)),
      Effect.withTracerEnabled(false),
      Effect.forkScoped,
    );

    const paused = SubscriptionRef.changes(known).pipe(
      Stream.filter(Option.isSome),
      Stream.map((read) => read.value),
      Stream.changes,
    );

    return Turns.of({ start, isRunning, stop, pause, resume, paused });
  }),
);
