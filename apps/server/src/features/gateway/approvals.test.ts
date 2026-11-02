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
  type RecordedAnswer,
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

/** A row of the audit trail that is written. */
const written = () => Effect.void;

/** A row of the audit trail whose write fails, as on a full disk. */
const failing = Effect.fail("disk full");

/** Opens a question about removing notes.txt in `turn` under `askRule`, its ask row written. */
const opened = (
  store: Effect.Success<typeof approvalRequests>,
  turn: typeof firstRun,
  askRule = rule,
) => store.open(turn, askRule, removeNotes, written);

/** Asks `approval` about removing notes.txt, in a fiber of its own, its answer row written. */
const asking = (approval: OpenApproval) =>
  Effect.forkChild(approval.ask("Run `rm notes.txt`?", "10 minutes", written));

/** Opens a question about removing notes.txt in `turn` and answers it `answer`, held until the scope closes. */
const answered = (
  store: Effect.Success<typeof approvalRequests>,
  turn: typeof firstRun,
  answer: "yes" | "no",
) =>
  Effect.gen(function* () {
    const approval = yield* opened(store, turn);
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
    "records a question as asked, shows it only once asked, and hands the person's yes to the wait",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* approvalRequests;
          const approval = yield* opened(store, firstRun);

          expect(yield* ledger).toEqual([["run-1", "asked"]]);
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
        yield* opened(store, firstRun);

        expect(yield* Effect.flip(opened(store, firstRun, "another-rule"))).toEqual(
          new AlreadyWaiting(),
        );

        const elsewhere = {
          conversation: ConversationId.make("conversation-2"),
          run: firstRun.run,
        };

        yield* asking(yield* opened(store, elsewhere));

        expect((yield* untilShown(store.requests, elsewhere.conversation)).tool).toBe("run");
      }),
    ).pipe(Effect.provide(database)),
  );

  it.effect("answers no once the time limit passes, and takes no answer after it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* approvalRequests;
        const approval = yield* opened(store, firstRun);
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

  it.effect(
    "records no for a question whose wait was stopped, with its row, and withdraws it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* approvalRequests;
          const approval = yield* opened(store, firstRun);
          const rows: Array<RecordedAnswer> = [];

          const waiting = yield* Effect.forkChild(
            approval.ask("Run `rm notes.txt`?", "10 minutes", (given) =>
              Effect.sync(() => rows.push(given)),
            ),
          );

          yield* untilShown(store.requests);
          yield* Fiber.interrupt(waiting);

          expect(rows).toEqual([{ answer: "no", by: "the turn was stopped" }]);
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

        expect(yield* Effect.flip(approval.spend(otherCommand, Effect.void))).toEqual(
          new ActionChanged({ action: otherCommand.action }),
        );
        expect(yield* approval.spent).toBe(false);

        expect(yield* approval.spend(removeNotes, Effect.succeed("allow row"))).toBe("allow row");

        expect(yield* approval.spent).toBe(true);
        expect(yield* Effect.flip(approval.spend(removeNotes, Effect.void))).toEqual(
          new AlreadySpent(),
        );

        yield* approval.finish;

        expect(yield* ledger).toEqual([["run-1", "finished"]]);
      }),
    ).pipe(Effect.provide(database)),
  );

  it.effect("lapses a yes it never spent once it is closed with its row", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* approvalRequests;
        const { approval } = yield* answered(store, firstRun, "yes");
        yield* approval.close(Effect.void);

        expect(yield* ledger).toEqual([["run-1", "lapsed"]]);
        expect(yield* Effect.flip(approval.spend(removeNotes, Effect.void))).toEqual(
          new AlreadySpent(),
        );
      }),
    ).pipe(Effect.provide(database)),
  );

  it.effect("keeps a no as it is when its question is closed with its row", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* approvalRequests;
        const { approval } = yield* answered(store, firstRun, "no");
        yield* approval.close(Effect.void);

        expect(yield* ledger).toEqual([["run-1", "no"]]);
      }),
    ).pipe(Effect.provide(database)),
  );

  it.effect("moves no row when the row that records the move cannot be written", () =>
    Effect.gen(function* () {
      const store = yield* approvalRequests;

      expect(
        yield* Effect.flip(Effect.scoped(store.open(firstRun, rule, removeNotes, () => failing))),
      ).toBe("disk full");
      expect(yield* ledger).toEqual([]);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const approval = yield* opened(store, firstRun);

          const waiting = yield* Effect.forkChild(
            approval.ask("Run `rm notes.txt`?", "10 minutes", () => failing),
          );

          yield* untilShown(store.requests);
          yield* store.requests.answer(conversation, approval.id, "yes");

          expect(yield* Effect.flip(Fiber.join(waiting))).toBe("disk full");
          expect(yield* ledger).toEqual([["run-1", "asked"]]);

          expect(yield* Effect.flip(approval.close(failing))).toBe("disk full");
          expect(yield* ledger).toEqual([["run-1", "asked"]]);
        }),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const { approval } = yield* answered(store, secondRun, "yes");

          expect(yield* Effect.flip(approval.spend(removeNotes, failing))).toBe("disk full");
          expect(yield* approval.spent).toBe(false);
          expect(yield* ledger).toEqual([
            ["run-1", "asked"],
            ["run-2", "yes"],
          ]);
        }),
      );
    }).pipe(Effect.provide(database)),
  );

  it.effect("refuses a no's rule again for the rest of its run, and asks again in the next", () =>
    Effect.gen(function* () {
      const store = yield* approvalRequests;

      expect((yield* askAndAnswer(store, firstRun, "no")).answered).toEqual({
        answer: "no",
        by: "person",
      });

      expect(yield* Effect.flip(Effect.scoped(opened(store, firstRun)))).toEqual(
        new DeclinedEarlier(),
      );
      expect(yield* shownIn(store.requests)).toEqual(Option.none());

      expect((yield* askAndAnswer(store, secondRun, "yes")).answered.answer).toBe("yes");
    }).pipe(Effect.provide(database)),
  );

  it.effect("holds the conversation for another card while no question waits and no no holds", () =>
    Effect.gen(function* () {
      const store = yield* approvalRequests;

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* store.hold(firstRun, rule);

          expect(yield* Effect.flip(opened(store, firstRun, "another-rule"))).toEqual(
            new AlreadyWaiting(),
          );
          expect(yield* shownIn(store.requests)).toEqual(Option.none());
        }),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* opened(store, firstRun);

          expect(yield* Effect.flip(store.hold(firstRun, "another-rule"))).toEqual(
            new AlreadyWaiting(),
          );
        }),
      );

      yield* askAndAnswer(store, secondRun, "no");

      expect(yield* Effect.flip(Effect.scoped(store.hold(secondRun, rule)))).toEqual(
        new DeclinedEarlier(),
      );
    }).pipe(Effect.provide(database)),
  );

  it.effect("records a no to another card's question, which refuses its rule for the run", () =>
    Effect.gen(function* () {
      const store = yield* approvalRequests;

      yield* Effect.scoped(
        Effect.flatMap(store.hold(firstRun, rule), (held) =>
          held.declined(bot, "request_secret", Effect.void),
        ),
      );

      expect(yield* ledger).toEqual([["run-1", "no"]]);
      expect(yield* Effect.flip(Effect.scoped(opened(store, firstRun)))).toEqual(
        new DeclinedEarlier(),
      );

      expect(
        yield* Effect.flip(
          Effect.scoped(
            Effect.flatMap(store.hold(secondRun, rule), (held) =>
              held.declined(bot, "request_secret", failing),
            ),
          ),
        ),
      ).toBe("disk full");
      expect(yield* ledger).toEqual([["run-1", "no"]]);
    }).pipe(Effect.provide(database)),
  );

  it.effect("tells of a yes an earlier run spent and never finished once, then asks again", () =>
    Effect.gen(function* () {
      const store = yield* approvalRequests;

      yield* Effect.scoped(
        Effect.flatMap(answered(store, firstRun, "yes"), ({ approval }) =>
          approval.spend(removeNotes, Effect.void),
        ),
      );

      const restarted = yield* approvalRequests;

      expect(yield* Effect.flip(Effect.scoped(opened(restarted, secondRun)))).toEqual(
        new OutcomeUnknown(),
      );
      expect((yield* askAndAnswer(restarted, secondRun, "no")).answered.answer).toBe("no");
      expect(yield* ledger).toEqual([
        ["run-1", "told"],
        ["run-2", "no"],
      ]);
    }).pipe(Effect.provide(database)),
  );

  it.effect("closes every question an earlier run left open, once, and keeps the rest", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* approvalRequests;
        yield* askAndAnswer(store, firstRun, "no");

        const { approval: approved } = yield* answered(store, secondRun, "yes");

        const elsewhere = {
          conversation: ConversationId.make("conversation-2"),
          run: firstRun.run,
        };

        const waiting = yield* opened(store, elsewhere);
        yield* asking(waiting);
        yield* untilShown(store.requests, elsewhere.conversation);

        const restarted = yield* approvalRequests;
        const closed = { bot, tool: "run", rule };

        expect(yield* restarted.closeLeftOpen(written)).toEqual([
          { approval: approved.id, ...closed, answered: true },
          { approval: waiting.id, ...closed, answered: false },
        ]);
        expect(yield* restarted.closeLeftOpen(written)).toEqual([]);
        expect(yield* ledger).toEqual([
          ["run-1", "no"],
          ["run-2", "lapsed"],
          ["run-1", "no"],
        ]);
      }),
    ).pipe(Effect.provide(database)),
  );

  it.effect("keeps a question left open whose rows cannot be written for the next start-up", () =>
    Effect.gen(function* () {
      const store = yield* approvalRequests;
      const approval = yield* Effect.scoped(Effect.map(opened(store, firstRun), ({ id }) => id));

      const restarted = yield* approvalRequests;

      expect(yield* restarted.closeLeftOpen(() => failing)).toEqual([]);
      expect(yield* ledger).toEqual([["run-1", "asked"]]);

      expect(yield* restarted.closeLeftOpen(written)).toEqual([
        { approval, bot, tool: "run", rule, answered: false },
      ]);
      expect(yield* ledger).toEqual([["run-1", "no"]]);
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
      yield* Scope.provide(opened(store, firstRun), scope);
      yield* Scope.close(scope, Exit.void);

      expect((yield* askAndAnswer(store, firstRun, "yes")).answered.answer).toBe("yes");
    }).pipe(Effect.provide(database)),
  );
});
