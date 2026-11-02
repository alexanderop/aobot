import { createHash } from "node:crypto";
import {
  type ApprovalAnswer,
  ApprovalId,
  type BotId,
  type ConversationId,
  NoApprovalWaiting,
  type PendingApproval,
  type ToolName,
} from "@aobot/domain";
import {
  Context,
  Deferred,
  type Duration,
  Effect,
  HashMap,
  Option,
  Schema,
  type Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import { SqlClient } from "effect/sql";
import type { TurnRef } from "./gateway.ts";
import { ToolAction } from "./tool-action.ts";

/** One action as it resolved, as a digest: an approval covers that action only. */
const ActionDigest = Schema.String.pipe(Schema.brand("ActionDigest"));

/** A decoded {@link ActionDigest}. */
type ActionDigest = typeof ActionDigest.Type;

// The schema writes each object's keys in its own order, so equal actions always read the same.
const encodeAction = Schema.encodeSync(ToolAction);

/**
The digest of `bot` taking `action` on a page at `host`: everything a rule could have read of it, a file's
contents and a page's element included. Kept in memory only.
*/
export function digestOf(bot: BotId, action: ToolAction, host: string): ActionDigest {
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
interface Answered {
  readonly answer: ApprovalAnswer;
  readonly by: "person" | "time limit";
}

/** Another question waits for the person in this conversation. */
export class AlreadyWaiting extends Schema.TaggedError<AlreadyWaiting>()("AlreadyWaiting", {}) {}

/** The person said no to an action `rule` asked about earlier in this run. */
export class DeclinedEarlier extends Schema.TaggedError<DeclinedEarlier>()("DeclinedEarlier", {
  rule: Schema.String,
}) {}

/**
An action `rule` asked about was approved and started in an earlier run, and that run never said what
became of it, as when the server stopped. It is not run again.
*/
export class OutcomeUnknown extends Schema.TaggedError<OutcomeUnknown>()("OutcomeUnknown", {
  rule: Schema.String,
}) {}

/** The action resolved differently after the person answered, so their answer does not cover it. */
export class ActionChanged extends Schema.TaggedError<ActionChanged>()("ActionChanged", {}) {}

/** The approval was already spent on its action, which runs once only. */
export class AlreadySpent extends Schema.TaggedError<AlreadySpent>()("AlreadySpent", {}) {}

/** The ledger of approvals could not be read or written, so nothing is asked or run. */
export class LedgerFailed extends Schema.TaggedError<LedgerFailed>()("LedgerFailed", {
  message: Schema.String,
}) {}

/** One question for a person, from {@link approvalRequests}'s `open`. */
export interface OpenApproval {
  readonly id: ApprovalId;
  /**
  Records the question as asked, shows it as `question` about `tool`, and waits for the person's answer, or
  no once `limit` passed; then records it and withdraws the question. Nothing is shown unrecorded, and an
  answer that took the question before the limit is kept. Interrupted, it records no.
  */
  readonly ask: (
    tool: ToolName,
    question: string,
    limit: Duration.Input,
  ) => Effect.Effect<Answered, LedgerFailed>;
  /**
  Spends a yes on the action, once: `current`, the action as it resolves now, must be the one asked about.
  */
  readonly spend: (
    current: ActionDigest,
  ) => Effect.Effect<void, ActionChanged | AlreadySpent | LedgerFailed>;
  /** Records that the Bot was told what became of the action the yes was spent on. */
  readonly finish: Effect.Effect<void>;
}

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
  | { readonly from: "yes"; readonly to: "spent" }
  | { readonly from: "spent"; readonly to: "finished" | "told" };

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
database, so a yes is spent once, a no holds for the rest of its run, and an action approved before a
restart is never run again.
*/
export const approvalRequests = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const questions = yield* SubscriptionRef.make<Questions>(HashMap.empty());

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

  /** Takes the question `id` out of `conversation`, when it is still there. */
  const withdraw = (conversation: ConversationId, id: ApprovalId) =>
    SubscriptionRef.update(questions, (all) =>
      Option.exists(HashMap.get(all, conversation), (waiting) => waiting.id === id)
        ? HashMap.remove(all, conversation)
        : all,
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

  /**
  Refuses before anything is shown: a no to `rule` earlier in this run, or a yes to it an earlier run
  spent and never finished, which the Bot is told of once.
  */
  const ledgerAllows = Effect.fnUntraced(function* (turn: TurnRef, rule: string) {
    const declined = yield* sql`
      SELECT id FROM approvals
      WHERE conversation_id = ${turn.conversation} AND run_id = ${turn.run}
        AND rule = ${rule} AND state = 'no'
      LIMIT 1
    `.pipe(Effect.mapError(ledgerFailed));

    if (declined.length > 0) return yield* new DeclinedEarlier({ rule });

    const told = yield* sql`
      UPDATE approvals SET state = 'told', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE conversation_id = ${turn.conversation} AND rule = ${rule} AND state = 'spent'
        AND run_id != ${turn.run}
      RETURNING id
    `.pipe(Effect.mapError(ledgerFailed));

    if (told.length > 0) return yield* new OutcomeUnknown({ rule });
  });

  /**
  Holds a question about the action `digest` names, which `rule` asks about, for `turn`'s conversation
  until the scope closes. Fails while another question waits there, or when the ledger refuses it.
  */
  const open = (
    turn: TurnRef,
    rule: string,
    digest: ActionDigest,
  ): Effect.Effect<
    OpenApproval,
    AlreadyWaiting | DeclinedEarlier | OutcomeUnknown | LedgerFailed,
    Scope.Scope
  > =>
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
            HashMap.has(all, turn.conversation)
              ? [false, all]
              : [true, HashMap.set(all, turn.conversation, waiting)],
        );

        if (!held) return yield* new AlreadyWaiting();

        return waiting;
      }),
      ({ id }) => withdraw(turn.conversation, id),
    ).pipe(
      Effect.tap(() => ledgerAllows(turn, rule)),
      Effect.map(({ id, answer }): OpenApproval => {
        const record = (given: ApprovalAnswer) =>
          advance(id, { from: "asked", to: given }).pipe(
            Effect.andThen(withdraw(turn.conversation, id)),
          );

        const show = (tool: ToolName, question: string) =>
          sql`
            INSERT INTO approvals (id, conversation_id, run_id, rule, state)
            VALUES (${id}, ${turn.conversation}, ${turn.run}, ${rule}, 'asked')
          `.pipe(
            Effect.mapError(ledgerFailed),
            Effect.andThen(
              SubscriptionRef.update(questions, (all) =>
                HashMap.modifyAt(
                  all,
                  turn.conversation,
                  Option.map((waiting) =>
                    waiting.id === id
                      ? { ...waiting, card: Option.some({ approval: id, tool, question }) }
                      : waiting,
                  ),
                ),
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

        return {
          id,
          ask: (tool, question, limit) =>
            show(tool, question).pipe(
              Effect.andThen(answerWithin(limit)),
              Effect.tap(({ answer: given }) => record(given)),
              Effect.onInterrupt(() =>
                record("no").pipe(
                  Effect.catchTag("LedgerFailed", (error) =>
                    Effect.logWarning("A stopped approval could not be recorded as no").pipe(
                      Effect.annotateLogs({ approval: id, reason: error.message }),
                    ),
                  ),
                ),
              ),
            ),
          spend: (current) =>
            current === digest
              ? Effect.flatMap(advance(id, { from: "yes", to: "spent" }), (spent) =>
                  spent ? Effect.void : Effect.fail(new AlreadySpent()),
                )
              : Effect.fail(new ActionChanged()),
          finish: advance(id, { from: "spent", to: "finished" }).pipe(
            Effect.asVoid,
            Effect.catchTag("LedgerFailed", (error) =>
              Effect.logWarning("A finished approval could not be recorded").pipe(
                Effect.annotateLogs({ approval: id, reason: error.message }),
              ),
            ),
          ),
        };
      }),
    );

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

  return { open, requests: ApprovalRequests.of({ pending, answer }) };
});
