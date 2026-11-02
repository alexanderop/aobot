import { createHash } from "node:crypto";
import {
  type ApprovalAnswer,
  type ApprovalAnsweredBy,
  ApprovalId,
  BotId,
  type ConversationId,
  NoApprovalWaiting,
  type PendingApproval,
  ToolName,
} from "@aobot/domain";
import {
  Context,
  Deferred,
  type Duration,
  Effect,
  HashMap,
  Option,
  Ref,
  Schema,
  type Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import { SqlClient, SqlError } from "effect/sql";
import { ToolAction } from "./tool-action.ts";
import type { TurnRef } from "./turn.ts";

/** One action as it resolved, as a digest: an approval covers that action only. */
const ActionDigest = Schema.String.pipe(Schema.brand("ActionDigest"));

/** A decoded {@link ActionDigest}. */
type ActionDigest = typeof ActionDigest.Type;

// The schema writes each object's keys in its own order, so equal actions always read the same.
const encodeAction = Schema.encodeSync(ToolAction);

/** `bot` taking `action` on a page at `host`, as the gateway resolved it: what a rule judged. */
export interface ResolvedAction {
  readonly bot: BotId;
  readonly action: ToolAction;
  readonly host: string;
}

/**
The digest of a resolved action: everything a rule could have read of it, a file's contents and a page's
element included. Kept in memory only.
*/
export function digestOf({ bot, action, host }: ResolvedAction): ActionDigest {
  return ActionDigest.make(
    createHash("sha256")
      .update(JSON.stringify([bot, encodeAction(action), host]))
      .digest("hex"),
  );
}

/** A person answering an action a rule asked them about. */
export class ApprovalRequests extends Context.Service<
  ApprovalRequests,
  {
    /** The question `conversation` waits on, if any: now, then each change. */
    readonly pending: (
      conversation: ConversationId,
    ) => Stream.Stream<Option.Option<PendingApproval>>;
    /**
    Hands `answer` to the question `approval` in `conversation`. Fails when that question is not the one
    shown: it was never shown, or it was answered, timed out or stopped.
    */
    readonly answer: (
      conversation: ConversationId,
      approval: ApprovalId,
      answer: ApprovalAnswer,
    ) => Effect.Effect<void, NoApprovalWaiting>;
  }
>()("aobot/gateway/ApprovalRequests") {}

/** How a question was answered, and by whom: the person, or the time limit, which answers no. */
export interface Answered {
  readonly answer: ApprovalAnswer;
  readonly by: Extract<ApprovalAnsweredBy, "person" | "time limit">;
}

/** An answer as its `approval.answered` row records it: also a no for a turn stopped while it waited. */
export interface RecordedAnswer {
  readonly answer: ApprovalAnswer;
  readonly by: ApprovalAnsweredBy;
}

/** Another question waits for the person in this conversation. */
export class AlreadyWaiting extends Schema.TaggedError<AlreadyWaiting>()("AlreadyWaiting", {}) {}

/** The person said no to an action the same ask rule asked about earlier in this run. */
export class DeclinedEarlier extends Schema.TaggedError<DeclinedEarlier>()("DeclinedEarlier", {}) {}

/**
An action the same ask rule asked about was approved and started in an earlier run, and that run never
said what became of it, as when the turn or the server stopped. It is not run again.
*/
export class OutcomeUnknown extends Schema.TaggedError<OutcomeUnknown>()("OutcomeUnknown", {}) {}

/**
The action resolved as `action` after the person answered, not as the one they were asked about, so their
answer does not cover it.
*/
export class ActionChanged extends Schema.TaggedError<ActionChanged>()("ActionChanged", {
  action: ToolAction,
}) {}

/** The approval was already spent on its action, which runs once only. */
export class AlreadySpent extends Schema.TaggedError<AlreadySpent>()("AlreadySpent", {}) {}

/** The ledger of approvals could not be read or written, so nothing is asked or run. */
export class LedgerFailed extends Schema.TaggedError<LedgerFailed>()("LedgerFailed", {
  message: Schema.String,
}) {}

/**
One question for a person, from {@link approvalRequests}'s `open`, recorded as asked. Every move of its
ledger row commits in one write with the row of the audit trail that records it, or neither does: a move
whose row failed leaves the ledger where it was, for the start-up sweep to close.
*/
export interface OpenApproval {
  readonly id: ApprovalId;
  /**
  Shows the question as `question` and waits for the person's answer, or no once `limit` passed, and
  records it with `answered`, its row. Interrupted, it records no for a stopped turn.
  */
  readonly ask: <E>(
    question: string,
    limit: Duration.Input,
    answered: (answer: RecordedAnswer) => Effect.Effect<unknown, E>,
  ) => Effect.Effect<Answered, E | LedgerFailed>;
  /**
  Spends a yes on `current`, the action as it resolves now, which must be the one asked about, with
  `allowed`, its row, whose result it returns. A yes is spent once.
  */
  readonly spend: <A, E>(
    current: ResolvedAction,
    allowed: Effect.Effect<A, E>,
  ) => Effect.Effect<A, ActionChanged | AlreadySpent | LedgerFailed | E>;
  /** Whether {@link spend} spent the yes, so the action was carried out or started. */
  readonly spent: Effect.Effect<boolean>;
  /** Records that the Bot was told what became of the action the yes was spent on. */
  readonly finish: Effect.Effect<void>;
  /** Ends the question without its action with `refused`, its row: one still asked, or a yes not spent, lapses. */
  readonly close: <E>(refused: Effect.Effect<unknown, E>) => Effect.Effect<void, E | LedgerFailed>;
}

/**
A question an earlier run left open, as when the server stopped while it waited for the person or before
its yes was spent: the Bot it was asked for, the tool and the ask rule, and whether it was answered.
*/
export interface LeftOpen {
  readonly approval: ApprovalId;
  readonly bot: BotId;
  readonly tool: ToolName;
  readonly rule: string;
  readonly answered: boolean;
}

const decodeLeftOpen = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: ApprovalId,
      bot_id: BotId,
      tool: ToolName,
      rule: Schema.String,
      state: Schema.Literals(["asked", "yes"]),
    }),
  ),
);

/** A question held for its conversation: its answer, and the card while the person may answer it. */
interface Waiting {
  readonly id: ApprovalId;
  readonly answer: Deferred.Deferred<ApprovalAnswer>;
  readonly card: Option.Option<PendingApproval>;
}

/** The question each conversation waits on, by the conversation. */
type Questions = HashMap.HashMap<ConversationId, Waiting>;

/** One forward move of a ledger row. */
type Move =
  | { readonly from: "asked"; readonly to: ApprovalAnswer }
  | { readonly from: "yes"; readonly to: "spent" | "lapsed" }
  | { readonly from: "spent"; readonly to: "finished" | "told" };

/** A ledger row as it is written: the question's Bot, tool and ask rule, in its turn. */
interface Question {
  readonly id: ApprovalId;
  readonly turn: TurnRef;
  readonly bot: BotId;
  readonly tool: ToolName;
  readonly rule: string;
}

const notWaiting = new NoApprovalWaiting({
  message: "The Bot is not waiting for that answer any more, so it was not taken.",
});

const sameCard = Option.makeEquivalence<PendingApproval>((a, b) => a.approval === b.approval);

function ledgerFailed(error: { readonly message: string }) {
  return new LedgerFailed({ message: error.message });
}

/**
Where each conversation's question waits for the person, one at a time, and the ledger that keeps what
became of every one across restarts. The question waits in memory, inside one turn; the ledger is in the
database, so a yes is spent once or lapses, a no holds for the rest of its run, and an action approved
before a restart is never run again. The audit trail must be on the same database client, so a row it
writes inside a ledger move joins that move's transaction.
*/
export const approvalRequests = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const questions = yield* SubscriptionRef.make<Questions>(HashMap.empty());

  /** `effect` as one transaction: every write in it commits, or none does. */
  const inOneWrite = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    sql
      .withTransaction(effect)
      .pipe(Effect.catchIf(SqlError.isSqlError, (error) => Effect.fail(ledgerFailed(error))));

  /** Moves the row `id` as `move` says, when it is still in `move.from`, and says whether it did. */
  const advance = (id: ApprovalId, move: Move) =>
    sql`
      UPDATE approvals SET state = ${move.to}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ${id} AND state = ${move.from}
      RETURNING id
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(ledgerFailed),
    );

  /** Writes the ledger row of `question`, as asked. */
  const insert = ({ id, turn, bot, tool, rule }: Question) =>
    sql`
      INSERT INTO approvals (id, conversation_id, run_id, bot_id, tool, rule, state)
      VALUES (${id}, ${turn.conversation}, ${turn.run}, ${bot}, ${tool}, ${rule}, 'asked')
    `.pipe(Effect.asVoid, Effect.mapError(ledgerFailed));

  /** Takes the question `id` out of `conversation`, when it is still there. */
  const withdraw = (conversation: ConversationId, id: ApprovalId) =>
    SubscriptionRef.update(questions, (all) =>
      Option.exists(HashMap.get(all, conversation), (waiting) => waiting.id === id)
        ? HashMap.remove(all, conversation)
        : all,
    );

  /** Holds `conversation` for one question, with no card yet, until the scope closes. */
  const holdConversation = (conversation: ConversationId) =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        const waiting: Waiting = {
          id: ApprovalId.make(crypto.randomUUID()),
          answer: yield* Deferred.make<ApprovalAnswer>(),
          card: Option.none(),
        };

        const held = yield* SubscriptionRef.modify(
          questions,
          (all): readonly [boolean, Questions] =>
            HashMap.has(all, conversation)
              ? [false, all]
              : [true, HashMap.set(all, conversation, waiting)],
        );

        if (!held) return yield* new AlreadyWaiting();

        return waiting;
      }),
      ({ id }) => withdraw(conversation, id),
    );

  /**
  Takes the card of the question `id` down, when it is still up, and gives its answer to hand over. Whoever
  takes it, the person or the time limit, answers.
  */
  const takeCard = (conversation: ConversationId, id: ApprovalId) =>
    SubscriptionRef.modify(
      questions,
      (all): readonly [Option.Option<Deferred.Deferred<ApprovalAnswer>>, Questions] =>
        Option.match(
          Option.filter(
            HashMap.get(all, conversation),
            (waiting) => waiting.id === id && Option.isSome(waiting.card),
          ),
          {
            onNone: () => [Option.none(), all],
            onSome: (waiting) => [
              Option.some(waiting.answer),
              HashMap.set(all, conversation, { ...waiting, card: Option.none() }),
            ],
          },
        ),
    );

  /** Refuses an action the ask rule `rule` holds for after the person said no to it earlier in `turn`'s run. */
  const notDeclined = Effect.fnUntraced(function* (turn: TurnRef, rule: string) {
    const declined = yield* sql`
      SELECT id FROM approvals
      WHERE conversation_id = ${turn.conversation} AND run_id = ${turn.run}
        AND rule = ${rule} AND state = 'no'
      LIMIT 1
    `.pipe(Effect.mapError(ledgerFailed));

    if (declined.length > 0) return yield* new DeclinedEarlier();
  });

  /**
  Refuses before anything is shown: a no to `rule` earlier in this run, or a yes to it an earlier run
  spent and never finished, which the Bot is told of once.
  */
  const ledgerAllows = Effect.fnUntraced(function* (turn: TurnRef, rule: string) {
    yield* notDeclined(turn, rule);

    const told = yield* sql`
      UPDATE approvals SET state = 'told', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE conversation_id = ${turn.conversation} AND rule = ${rule} AND state = 'spent'
        AND run_id != ${turn.run}
      RETURNING id
    `.pipe(Effect.mapError(ledgerFailed));

    if (told.length > 0) return yield* new OutcomeUnknown();
  });

  /**
  Whether the person may be asked, in `turn`'s conversation, about an action the ask rule `rule` holds for
  that another card asks instead, as a secret's does: not while a question waits there, nor after a no to
  that rule earlier in its run. Shows and records nothing.
  */
  const mayAsk = Effect.fnUntraced(function* (turn: TurnRef, rule: string) {
    if (HashMap.has(yield* SubscriptionRef.get(questions), turn.conversation)) {
      return yield* new AlreadyWaiting();
    }

    yield* notDeclined(turn, rule);
  });

  /**
  Holds a question about `asked`, which the ask rule `rule` asks about, for `turn`'s conversation until the
  scope closes, and records it as asked with `recorded`, its row, given its id. Refused while another
  question waits there, or when the ledger refuses it.
  */
  const open = <E>(
    turn: TurnRef,
    rule: string,
    asked: ResolvedAction,
    recorded: (id: ApprovalId) => Effect.Effect<unknown, E>,
  ): Effect.Effect<
    OpenApproval,
    AlreadyWaiting | DeclinedEarlier | OutcomeUnknown | LedgerFailed | E,
    Scope.Scope
  > =>
    Effect.gen(function* () {
      const { id, answer } = yield* holdConversation(turn.conversation);
      yield* ledgerAllows(turn, rule);

      const tool = asked.action.action;
      const question: Question = { id, turn, bot: asked.bot, tool, rule };
      yield* inOneWrite(Effect.andThen(insert(question), recorded(id)));

      const digest = digestOf(asked);
      const spent = yield* Ref.make(false);

      const show = (shown: string) =>
        SubscriptionRef.update(questions, (all) =>
          HashMap.modifyAt(
            all,
            turn.conversation,
            Option.map((waiting) =>
              waiting.id === id
                ? { ...waiting, card: Option.some({ approval: id, tool, question: shown }) }
                : waiting,
            ),
          ),
        );

      const byPerson = (given: ApprovalAnswer): Answered => ({ answer: given, by: "person" });

      const answerWithin = (limit: Duration.Input) =>
        Deferred.await(answer).pipe(
          Effect.timeoutOption(limit),
          Effect.flatMap(
            Option.match({
              onSome: (given) => Effect.succeed(byPerson(given)),
              onNone: () =>
                Effect.flatMap(takeCard(turn.conversation, id), (timedOut) =>
                  Option.isSome(timedOut)
                    ? Effect.succeed<Answered>({ answer: "no", by: "time limit" })
                    : Effect.map(Deferred.await(answer), byPerson),
                ),
            }),
          ),
        );

      const approval: OpenApproval = {
        id,
        ask: (shown, limit, answered) => {
          const record = (given: RecordedAnswer) =>
            inOneWrite(
              Effect.andThen(advance(id, { from: "asked", to: given.answer }), answered(given)),
            );

          return show(shown).pipe(
            Effect.andThen(answerWithin(limit)),
            Effect.tap(record),
            Effect.onInterrupt(() =>
              record({ answer: "no", by: "the turn was stopped" }).pipe(
                Effect.ignore({ log: "Warn", message: "A stopped approval could not be recorded" }),
                Effect.annotateLogs({ approval: id }),
              ),
            ),
            Effect.ensuring(withdraw(turn.conversation, id)),
          );
        },
        // Uninterruptible, so `spent` always says what the ledger says once the write is over.
        spend: <A, E>(current: ResolvedAction, allowed: Effect.Effect<A, E>) =>
          digestOf(current) === digest
            ? Effect.uninterruptible(
                inOneWrite(
                  Effect.flatMap(
                    advance(id, { from: "yes", to: "spent" }),
                    (moved): Effect.Effect<A, E | AlreadySpent> =>
                      moved ? allowed : Effect.fail(new AlreadySpent()),
                  ),
                ).pipe(Effect.tap(Ref.set(spent, true))),
              )
            : Effect.fail(new ActionChanged({ action: current.action })),
        spent: Ref.get(spent),
        finish: advance(id, { from: "spent", to: "finished" }).pipe(
          Effect.asVoid,
          Effect.catchTag("LedgerFailed", (error) =>
            Effect.logWarning("A finished approval could not be recorded").pipe(
              Effect.annotateLogs({ approval: id, reason: error.message }),
            ),
          ),
        ),
        close: (refused) =>
          inOneWrite(
            sql`
              UPDATE approvals SET state = 'lapsed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              WHERE id = ${id} AND state IN ('asked', 'yes')
            `.pipe(Effect.mapError(ledgerFailed), Effect.andThen(refused)),
          ),
      };

      return approval;
    });

  const pending = (conversation: ConversationId) =>
    SubscriptionRef.changes(questions).pipe(
      Stream.map((all) => Option.flatMap(HashMap.get(all, conversation), ({ card }) => card)),
      Stream.changesWith(sameCard),
    );

  const answer = Effect.fn("ApprovalRequests.answer")(function* (
    conversation: ConversationId,
    approval: ApprovalId,
    given: ApprovalAnswer,
  ) {
    const taken = yield* takeCard(conversation, approval);

    yield* Option.match(taken, {
      onNone: () => Effect.fail(notWaiting),
      onSome: (handed) => Deferred.succeed(handed, given),
    });
  });

  /**
  Closes every question an earlier run left open, each with `closeInTrail`, its rows, in one write: one
  still asked is answered no, and a yes never spent lapses. Returns each it closed; one whose write failed
  stays open for the next start-up. Run at start-up, before any question is asked.
  */
  const closeLeftOpen = <E>(closeInTrail: (left: LeftOpen) => Effect.Effect<unknown, E>) =>
    Effect.gen(function* () {
      const open = yield* sql`
        SELECT id, bot_id, tool, rule, state FROM approvals
        WHERE state IN ('asked', 'yes')
        ORDER BY rowid
      `.pipe(Effect.flatMap(decodeLeftOpen), Effect.mapError(ledgerFailed));

      const closed = yield* Effect.forEach(open, ({ id, bot_id, tool, rule, state }) => {
        const left: LeftOpen = { approval: id, bot: bot_id, tool, rule, answered: state === "yes" };

        const move: Move =
          state === "asked" ? { from: "asked", to: "no" } : { from: "yes", to: "lapsed" };

        return inOneWrite(
          Effect.flatMap(advance(id, move), (moved) =>
            moved ? Effect.as(closeInTrail(left), Option.some(left)) : Effect.succeedNone,
          ),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.as(
              Effect.logError(
                "A question left open could not be closed; the next start tries again",
                cause,
              ).pipe(Effect.annotateLogs({ approval: id })),
              Option.none<LeftOpen>(),
            ),
          ),
        );
      });

      return closed.flatMap(Option.toArray);
    });

  return { open, mayAsk, closeLeftOpen, requests: ApprovalRequests.of({ pending, answer }) };
});
