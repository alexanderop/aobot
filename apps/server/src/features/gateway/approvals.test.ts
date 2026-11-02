import { BotId, ConversationId, NoApprovalWaiting, RunId } from "@aobot/domain";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Option, Scope, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import {
  ActionChanged,
  AlreadySpent,
  AlreadyWaiting,
  type ApprovalRequests,
  approvalRequests,
  DeclinedEarlier,
  digestOf,
  type OpenApproval,
  OutcomeUnknown,
  type ResolvedAction,
} from "./approvals.ts";
import { database } from "./testing/test-gateway.ts";

const bot = BotId.make("assistant");

const conversation = ConversationId.make("conversation-1");

const firstRun = { conversation, run: RunId.make("run-1") };

const secondRun = { conversation, run: RunId.make("run-2") };

const rule = "ask-before-delete";

const removeNotes: ResolvedAction = {
  bot,
  action: { action: "run", command: "rm notes.txt" },
  host: "",
};

/** Removing notes.txt as `more` changes it. */
const otherThan = (more: Partial<ResolvedAction>): ResolvedAction => ({ ...removeNotes, ...more });

/** The question the person is shown in `conversation` now. */
const shownIn = (requests: ApprovalRequests["Service"], shownConversation = conversation) =>
  requests.pending(shownConversation).pipe(Stream.runHead, Effect.map(Option.flatten));

/** Each ledger row's run and state, oldest first. */
const ledger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT run_id, state FROM approvals ORDER BY rowid`;

  return rows.map((row) => [row["run_id"], row["state"]]);
});

/** The question shown in `shownConversation`, once there is one. */
const untilShown = (requests: ApprovalRequests["Service"], shownConversation = conversation) =>
  requests.pending(shownConversation).pipe(
    Stream.filter(Option.isSome),
    Stream.runHead,
    Effect.map((shown) => Option.getOrThrow(Option.flatten(shown))),
  );

/** Asks `approval` about removing notes.txt, in a fiber of its own. */
const asking = (approval: OpenApproval) =>
  Effect.forkChild(approval.ask("run", "Run `rm notes.txt`?", "10 minutes"));

/** Opens a question about removing notes.txt in `turn` and answers it `answer`, held until the scope closes. */
const answered = (
  store: Effect.Success<typeof approvalRequests>,
  turn: typeof firstRun,
  answer: "yes" | "no",
) =>
  Effect.gen(function* () {
    const approval = yield* store.open(turn, rule, removeNotes);
    const waiting = yield* asking(approval);
    yield* untilShown(store.requests, turn.conversation);
    yield* store.requests.answer(turn.conversation, approval.id, answer);

    return { approval, answered: yield* Fiber.join(waiting) };
  });

/** {@link answered}, in a scope of its own. */
const askAndAnswer = (
  store: Effect.Success<typeof approvalRequests>,
  turn: typeof firstRun,
  answer: "yes" | "no",
) => Effect.scoped(answered(store, turn, answer));

describe("digestOf", () => {
  it("is the same for the same action, however its object was written", () => {
    const target = { ref: "e3", role: "button", name: "Delete", url: "https://shop.example" };
    const reordered = { url: target.url, name: target.name, role: target.role, ref: target.ref };

    expect(digestOf({ bot, action: { action: "click", target }, host: "shop.example" })).toBe(
      digestOf({ bot, action: { target: reordered, action: "click" }, host: "shop.example" }),
    );
  });

  it.each([
    ["another command", otherThan({ action: { action: "run", command: "rm ./notes.txt" } })],
    ["another Bot", otherThan({ bot: BotId.make("researcher") })],
    ["another host", otherThan({ host: "shop.example" })],
  ])("differs for %s", (_case, other) => {
    expect(digestOf(other)).not.toBe(digestOf(removeNotes));
  });

  it("differs for a write of other contents to the same file", () => {
    const write = (contents: string) =>
      digestOf(otherThan({ action: { action: "write_file", path: "notes.txt", contents } }));

    expect(write("a")).not.toBe(write("b"));
  });
});

describe("approvalRequests", () => {
  it.effect(
    "shows a question only once it is recorded, and hands the person's yes to the wait",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* approvalRequests;
          const approval = yield* store.open(firstRun, rule, removeNotes);

          expect(yield* shownIn(store.requests)).toEqual(Option.none());
          expect(
            yield* Effect.flip(store.requests.answer(conversation, approval.id, "yes")),
          ).toEqual(
            new NoApprovalWaiting({
              message: "The Bot is not waiting for that answer any more, so it was not taken.",
            }),
          );

          const waiting = yield* asking(approval);

          expect(yield* untilShown(store.requests)).toEqual({
            approval: approval.id,
            tool: "run",
            question: "Run `rm notes.txt`?",
          });
          expect(yield* ledger).toEqual([["run-1", "asked"]]);

          yield* store.requests.answer(conversation, approval.id, "yes");

          expect(yield* Fiber.join(waiting)).toEqual({ answer: "yes", by: "person" });
          expect(yield* shownIn(store.requests)).toEqual(Option.none());
          expect(yield* ledger).toEqual([["run-1", "yes"]]);
        }),
      ).pipe(Effect.provide(database)),
  );

  it.effect("holds one question per conversation, and refuses a second while it waits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* approvalRequests;
        yield* store.open(firstRun, rule, removeNotes);

        expect(yield* Effect.flip(store.open(firstRun, "another-rule", removeNotes))).toEqual(
          new AlreadyWaiting(),
        );

        const elsewhere = {
          conversation: ConversationId.make("conversation-2"),
          run: firstRun.run,
        };

        yield* asking(yield* store.open(elsewhere, rule, removeNotes));

        expect((yield* untilShown(store.requests, elsewhere.conversation)).tool).toBe("run");
      }),
    ).pipe(Effect.provide(database)),
  );

  it.effect("answers no once the time limit passes, and takes no answer after it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* approvalRequests;
        const approval = yield* store.open(firstRun, rule, removeNotes);
        const waiting = yield* asking(approval);
        yield* untilShown(store.requests);
        yield* TestClock.adjust("10 minutes");

        expect(yield* Fiber.join(waiting)).toEqual({ answer: "no", by: "time limit" });
        expect(
          yield* Effect.flip(store.requests.answer(conversation, approval.id, "yes")),
        ).toBeInstanceOf(NoApprovalWaiting);
        expect(yield* ledger).toEqual([["run-1", "no"]]);
      }),
    ).pipe(Effect.provide(database)),
  );

  it.effect("records no for a question whose wait was stopped, and withdraws it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* approvalRequests;
        const waiting = yield* asking(yield* store.open(firstRun, rule, removeNotes));
        yield* untilShown(store.requests);
        yield* Fiber.interrupt(waiting);

        expect(yield* ledger).toEqual([["run-1", "no"]]);
        expect(yield* shownIn(store.requests)).toEqual(Option.none());
      }),
    ).pipe(Effect.provide(database)),
  );

  it.effect("spends a yes once, and only on the action it was given for", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* approvalRequests;

        const { approval } = yield* answered(store, firstRun, "yes");
        const otherCommand = otherThan({ action: { action: "run", command: "rm -r notes" } });

        expect(yield* Effect.flip(approval.spend(otherCommand))).toEqual(
          new ActionChanged({ action: otherCommand.action }),
        );
        expect(yield* approval.spent).toBe(false);

        yield* approval.spend(removeNotes);

        expect(yield* approval.spent).toBe(true);
        expect(yield* Effect.flip(approval.spend(removeNotes))).toEqual(new AlreadySpent());

        yield* approval.finish;

        expect(yield* ledger).toEqual([["run-1", "finished"]]);
      }),
    ).pipe(Effect.provide(database)),
  );

  it.effect("lapses a yes it never spent once its question closes", () =>
    Effect.gen(function* () {
      const store = yield* approvalRequests;
      const { approval } = yield* askAndAnswer(store, firstRun, "yes");

      expect(yield* ledger).toEqual([["run-1", "lapsed"]]);
      expect(yield* Effect.flip(approval.spend(removeNotes))).toEqual(new AlreadySpent());
    }).pipe(Effect.provide(database)),
  );

  it.effect("refuses a no's rule again for the rest of its run, and asks again in the next", () =>
    Effect.gen(function* () {
      const store = yield* approvalRequests;

      expect((yield* askAndAnswer(store, firstRun, "no")).answered).toEqual({
        answer: "no",
        by: "person",
      });

      expect(yield* Effect.flip(Effect.scoped(store.open(firstRun, rule, removeNotes)))).toEqual(
        new DeclinedEarlier(),
      );
      expect(yield* shownIn(store.requests)).toEqual(Option.none());

      expect((yield* askAndAnswer(store, secondRun, "yes")).answered.answer).toBe("yes");
    }).pipe(Effect.provide(database)),
  );

  it.effect("tells of a yes an earlier run spent and never finished once, then asks again", () =>
    Effect.gen(function* () {
      const store = yield* approvalRequests;

      yield* Effect.scoped(
        Effect.flatMap(answered(store, firstRun, "yes"), ({ approval }) =>
          approval.spend(removeNotes),
        ),
      );

      const restarted = yield* approvalRequests;

      expect(
        yield* Effect.flip(Effect.scoped(restarted.open(secondRun, rule, removeNotes))),
      ).toEqual(new OutcomeUnknown());
      expect((yield* askAndAnswer(restarted, secondRun, "no")).answered.answer).toBe("no");
      expect(yield* ledger).toEqual([
        ["run-1", "told"],
        ["run-2", "no"],
      ]);
    }).pipe(Effect.provide(database)),
  );

  it.effect("keeps every row moving forward only, and never deletes one", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* approvalRequests;
      yield* askAndAnswer(store, firstRun, "no");

      const back = yield* Effect.flip(sql`UPDATE approvals SET state = 'asked'`);
      expect(String(back.reason.cause)).toContain("an approval only moves forward");

      const skip = yield* Effect.flip(sql`UPDATE approvals SET state = 'finished'`);
      expect(String(skip.reason.cause)).toContain("an approval only moves forward");

      const rewrite = yield* Effect.flip(sql`UPDATE approvals SET rule = 'another-rule'`);
      expect(String(rewrite.reason.cause)).toContain("an approval only moves forward");

      const remove = yield* Effect.flip(sql`DELETE FROM approvals`);
      expect(String(remove.reason.cause)).toContain("approvals cannot be deleted");

      expect(yield* ledger).toEqual([["run-1", "no"]]);
    }).pipe(Effect.provide(database)),
  );

  it.effect("withdraws a question it held when the scope closes before it was shown", () =>
    Effect.gen(function* () {
      const store = yield* approvalRequests;
      const scope = yield* Scope.make();
      yield* Scope.provide(store.open(firstRun, rule, removeNotes), scope);
      yield* Scope.close(scope, Exit.void);

      expect((yield* askAndAnswer(store, firstRun, "yes")).answered.answer).toBe("yes");
    }).pipe(Effect.provide(database)),
  );
});
