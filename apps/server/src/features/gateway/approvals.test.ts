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
  approvals,
  DeclinedEarlier,
  digestOf,
  OutcomeUnknown,
} from "./approvals.ts";
import { database } from "./testing/test-gateway.ts";

const bot = BotId.make("assistant");

const conversation = ConversationId.make("conversation-1");

const firstRun = { conversation, run: RunId.make("run-1") };

const secondRun = { conversation, run: RunId.make("run-2") };

const rule = "ask-before-delete";

const removeNotes = digestOf(bot, { action: "run", command: "rm notes.txt" }, "");

/** The question the person is shown in `conversation` now. */
const shownIn = (requests: ApprovalRequests["Service"], shownConversation = conversation) =>
  requests.pending(shownConversation).pipe(Stream.runHead, Effect.map(Option.flatten));

/** Each ledger row's run and state, oldest first. */
const ledger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT run_id, state FROM approvals ORDER BY rowid`;

  return rows.map((row) => [row["run_id"], row["state"]]);
});

/** Opens a question about removing notes.txt in `turn`, shows it and answers it `answer`, in a scope of its own. */
const askAndAnswer = (
  store: Effect.Success<typeof approvals>,
  turn: typeof firstRun,
  answer: "yes" | "no",
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const approval = yield* store.open(turn, rule, removeNotes);
      yield* approval.show("run", "Run `rm notes.txt`?");
      yield* store.requests.answer(turn.conversation, approval.id, answer);

      return { approval, answered: yield* approval.wait("10 minutes") };
    }),
  );

describe("digestOf", () => {
  it("is the same for the same action, however its object was written", () => {
    const target = { ref: "e3", role: "button", name: "Delete", url: "https://shop.example" };
    const reordered = { url: target.url, name: target.name, role: target.role, ref: target.ref };

    expect(digestOf(bot, { action: "click", target }, "shop.example")).toBe(
      digestOf(bot, { target: reordered, action: "click" }, "shop.example"),
    );
  });

  it.each([
    ["another command", digestOf(bot, { action: "run", command: "rm ./notes.txt" }, "")],
    [
      "another Bot",
      digestOf(BotId.make("researcher"), { action: "run", command: "rm notes.txt" }, ""),
    ],
    ["another host", digestOf(bot, { action: "run", command: "rm notes.txt" }, "shop.example")],
  ])("differs for %s", (_case, other) => {
    expect(other).not.toBe(removeNotes);
  });

  it("differs for a write of other contents to the same file", () => {
    const write = (contents: string) =>
      digestOf(bot, { action: "write_file", path: "notes.txt", contents }, "");

    expect(write("a")).not.toBe(write("b"));
  });
});

describe("approvals", () => {
  it.effect(
    "shows a question only once it is recorded, and hands the person's yes to the wait",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* approvals;
          const approval = yield* store.open(firstRun, rule, removeNotes);

          expect(yield* shownIn(store.requests)).toEqual(Option.none());
          expect(
            yield* Effect.flip(store.requests.answer(conversation, approval.id, "yes")),
          ).toEqual(
            new NoApprovalWaiting({
              message: "The Bot is not waiting for that answer any more, so it was not taken.",
            }),
          );

          yield* approval.show("run", "Run `rm notes.txt`?");

          expect(yield* ledger).toEqual([["run-1", "asked"]]);
          expect(yield* shownIn(store.requests)).toEqual(
            Option.some({ approval: approval.id, tool: "run", question: "Run `rm notes.txt`?" }),
          );

          yield* store.requests.answer(conversation, approval.id, "yes");

          expect(yield* approval.wait("10 minutes")).toEqual({ answer: "yes", by: "person" });
          expect(yield* shownIn(store.requests)).toEqual(Option.none());
          expect(yield* ledger).toEqual([["run-1", "yes"]]);
        }),
      ).pipe(Effect.provide(database)),
  );

  it.effect("holds one question per conversation, and refuses a second while it waits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* approvals;
        yield* store.open(firstRun, rule, removeNotes);

        expect(yield* Effect.flip(store.open(firstRun, "another-rule", removeNotes))).toEqual(
          new AlreadyWaiting(),
        );

        const elsewhere = {
          conversation: ConversationId.make("conversation-2"),
          run: firstRun.run,
        };

        const other = yield* store.open(elsewhere, rule, removeNotes);
        yield* other.show("run", "Run `rm notes.txt`?");

        expect(Option.isSome(yield* shownIn(store.requests, elsewhere.conversation))).toBe(true);
      }),
    ).pipe(Effect.provide(database)),
  );

  it.effect("answers no once the time limit passes, and takes no answer after it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* approvals;
        const approval = yield* store.open(firstRun, rule, removeNotes);
        yield* approval.show("run", "Run `rm notes.txt`?");

        const waiting = yield* Effect.forkChild(approval.wait("10 minutes"));
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
        const store = yield* approvals;
        const approval = yield* store.open(firstRun, rule, removeNotes);
        yield* approval.show("run", "Run `rm notes.txt`?");

        const waiting = yield* Effect.forkChild(approval.wait("10 minutes"));
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(waiting);

        expect(yield* ledger).toEqual([["run-1", "no"]]);
        expect(yield* shownIn(store.requests)).toEqual(Option.none());
      }),
    ).pipe(Effect.provide(database)),
  );

  it.effect("spends a yes once, and only on the action it was given for", () =>
    Effect.gen(function* () {
      const store = yield* approvals;

      const asked = yield* askAndAnswer(store, firstRun, "yes");
      const otherCommand = digestOf(bot, { action: "run", command: "rm -r notes" }, "");

      expect(yield* Effect.flip(asked.approval.spend(otherCommand))).toEqual(new ActionChanged());

      yield* asked.approval.spend(removeNotes);

      expect(yield* Effect.flip(asked.approval.spend(removeNotes))).toEqual(new AlreadySpent());

      yield* asked.approval.finish;

      expect(yield* ledger).toEqual([["run-1", "finished"]]);
    }).pipe(Effect.provide(database)),
  );

  it.effect("refuses a no's rule again for the rest of its run, and asks again in the next", () =>
    Effect.gen(function* () {
      const store = yield* approvals;

      expect((yield* askAndAnswer(store, firstRun, "no")).answered).toEqual({
        answer: "no",
        by: "person",
      });

      expect(yield* Effect.flip(Effect.scoped(store.open(firstRun, rule, removeNotes)))).toEqual(
        new DeclinedEarlier({ rule }),
      );
      expect(yield* shownIn(store.requests)).toEqual(Option.none());

      expect((yield* askAndAnswer(store, secondRun, "yes")).answered.answer).toBe("yes");
    }).pipe(Effect.provide(database)),
  );

  it.effect("tells of a yes an earlier run spent and never finished once, then asks again", () =>
    Effect.gen(function* () {
      const store = yield* approvals;

      const started = yield* askAndAnswer(store, firstRun, "yes");
      yield* started.approval.spend(removeNotes);

      const restarted = yield* approvals;

      expect(
        yield* Effect.flip(Effect.scoped(restarted.open(secondRun, rule, removeNotes))),
      ).toEqual(new OutcomeUnknown({ rule }));
      expect((yield* askAndAnswer(restarted, secondRun, "yes")).answered.answer).toBe("yes");
      expect(yield* ledger).toEqual([
        ["run-1", "told"],
        ["run-2", "yes"],
      ]);
    }).pipe(Effect.provide(database)),
  );

  it.effect("keeps every row moving forward only, and never deletes one", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* approvals;
      yield* askAndAnswer(store, firstRun, "yes");

      const back = yield* Effect.flip(sql`UPDATE approvals SET state = 'asked'`);
      expect(String(back.reason.cause)).toContain("an approval only moves forward");

      const skip = yield* Effect.flip(sql`UPDATE approvals SET state = 'finished'`);
      expect(String(skip.reason.cause)).toContain("an approval only moves forward");

      const rewrite = yield* Effect.flip(sql`UPDATE approvals SET rule = 'another-rule'`);
      expect(String(rewrite.reason.cause)).toContain("an approval only moves forward");

      const remove = yield* Effect.flip(sql`DELETE FROM approvals`);
      expect(String(remove.reason.cause)).toContain("approvals cannot be deleted");

      expect(yield* ledger).toEqual([["run-1", "yes"]]);
    }).pipe(Effect.provide(database)),
  );

  it.effect("withdraws a question it held when the scope closes before it was shown", () =>
    Effect.gen(function* () {
      const store = yield* approvals;
      const scope = yield* Scope.make();
      yield* Scope.provide(store.open(firstRun, rule, removeNotes), scope);
      yield* Scope.close(scope, Exit.void);

      expect((yield* askAndAnswer(store, firstRun, "yes")).answered.answer).toBe("yes");
    }).pipe(Effect.provide(database)),
  );
});
