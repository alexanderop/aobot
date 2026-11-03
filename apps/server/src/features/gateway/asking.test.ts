import {
  type ApprovalAnswer,
  CommandEnd,
  ConversationId,
  type PageAction,
  NoApprovalWaiting,
  type PageRead,
  type PendingApproval,
  RunId,
} from "@aobot/domain";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Result, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { recordedSpans } from "../../shared/testing/recorded-spans.ts";
import type { ToolFailed } from "../../shared/tool-result.ts";
import { assistant } from "../bots/testing/test-bots.ts";
import { policyFrom } from "../policy/testing/test-policy.ts";
import { ApprovalRequests } from "./approvals.ts";
import { ComputerControl } from "./control.ts";
import { approvalWaitLimit, Claim, Gateway } from "./gateway.ts";
import {
  auditRows,
  database,
  decodedTrail,
  fakeComputers,
  startGateway,
} from "./testing/test-gateway.ts";
import { CurrentActor, type PersonActor } from "../../shared/actor.ts";
import { alice, bob } from "../../shared/testing/people.ts";

const conversation = ConversationId.make("conversation-1");

/** The assistant's call in run `run` of the conversation. */
const inRun = (run: string) =>
  Claim.cases.Named.make({ bot: assistant.id, turn: { conversation, run: RunId.make(run) } });

const firstRun = inRun("run-1");

const askBeforeRm = policyFrom(`deny: []
allow:
  - name: granted-tools
    when: "true"
ask:
  - name: ask-before-rm
    when: command.startsWith("rm") || element.name == "Delete"
`);

const removeNotes = { action: "run", command: "rm notes.txt" } as const;

/** A computer whose every command exits 0, and keeps every action it was sent. */
function shell() {
  return fakeComputers({
    run: () =>
      Effect.succeed({
        action: "run",
        end: CommandEnd.cases.Exited.make({ code: 0 }),
        stdout: { text: "", truncated: false },
        stderr: { text: "", truncated: false },
        leftOutputOpen: false,
      }),
  });
}

/** The question `person`, alice unless named, is shown, once the conversation waits on one. */
const untilShown = (person: PersonActor = alice) =>
  ApprovalRequests.use((requests) =>
    requests.pending(conversation).pipe(
      Stream.filter(Option.isSome),
      Stream.runHead,
      Effect.map((shown) => Option.getOrThrow(Option.flatten(shown))),
    ),
  ).pipe(Effect.provideService(CurrentActor, person));

/** The question `person`, alice unless named, is shown now, if any. */
const shownNow = (person: PersonActor = alice) =>
  ApprovalRequests.use((requests) =>
    requests.pending(conversation).pipe(Stream.runHead, Effect.map(Option.flatten)),
  ).pipe(Effect.provideService(CurrentActor, person));

/** `person`'s `answer` to `shown`, alice's unless named. */
const answerTo = (shown: PendingApproval, answer: ApprovalAnswer, person: PersonActor = alice) =>
  ApprovalRequests.use((requests) => requests.answer(conversation, shown.approval, answer)).pipe(
    Effect.provideService(CurrentActor, person),
  );

/** What the model reads of an action like one approved earlier whose outcome it was never told. */
const outcomeUnknown =
  "run did not run: an action like it that your person approved was started, and its turn ended before you were told what became of it, so whether it happened is unknown, and it was not run again. Check what became of it, for example with ls or a snapshot, before asking again.";

/** What the model read of a call that was refused, or `""` for one that ran. */
const refusalOf = Result.match({
  onSuccess: () => "",
  onFailure: (failure: ToolFailed) => failure.message,
});

/** `request` in a fiber of its own, as `claim`. */
const actInBackground = (claim: Claim, request: Parameters<Gateway["Service"]["act"]>[1]) =>
  Gateway.use((gateway) => Effect.forkChild(Effect.result(gateway.act(claim, request))));

/** `request` as `claim`, answered `answer` once its question is shown, with what the person was shown. */
const askAndAnswer = (
  claim: Claim,
  request: Parameters<Gateway["Service"]["act"]>[1],
  answer: ApprovalAnswer,
) =>
  Effect.gen(function* () {
    const acting = yield* actInBackground(claim, request);
    const shown = yield* untilShown();
    yield* answerTo(shown, answer);

    return { shown, result: yield* Fiber.join(acting) };
  });

/** Makes every audit row matching the SQL condition `when` fail to be written, as a full disk would. */
const failAuditRowsWhere = (when: string) =>
  SqlClient.SqlClient.use((sql) =>
    sql.unsafe(`CREATE TRIGGER fail_audit BEFORE INSERT ON audit_rows WHEN ${when}
      BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`),
  );

const healAuditRows = SqlClient.SqlClient.use((sql) => sql.unsafe("DROP TRIGGER fail_audit"));

/** Each ledger row's state, oldest first. */
const ledger = SqlClient.SqlClient.use((sql) =>
  Effect.map(sql`SELECT state FROM approvals ORDER BY rowid`, (rows) =>
    rows.map((row) => row["state"]),
  ),
);

/** Each row of the trail that names `approval`, as `action · decision` and its reason. */
const rowsOf = (approval: string) =>
  Effect.map(decodedTrail, (trail) =>
    trail
      .filter(([, detail]) => detail.approval === approval)
      .map(([row, detail]) => [row, detail.reason]),
  );

describe("Gateway asking the person", () => {
  it.effect("runs an action once its person says yes, once, with each step in the trail", () =>
    Effect.gen(function* () {
      const computer = shell();
      const tracing = recordedSpans();

      const { shown, result } = yield* askAndAnswer(firstRun, removeNotes, "yes").pipe(
        Effect.provide(startGateway(computer.layer, askBeforeRm)),
        Effect.provide(tracing.layer),
      );

      expect(shown).toEqual({
        approval: expect.any(String),
        tool: "run",
        question: "Run `rm notes.txt`?",
      });
      expect(refusalOf(result)).toBe("");
      expect(computer.actions).toEqual([removeNotes]);

      const approval = shown.approval;

      expect(yield* decodedTrail).toEqual([
        [
          "run · ask",
          {
            bot: "assistant",
            command: "rm notes.txt",
            rule: "ask-before-rm",
            allowedBy: "granted-tools",
            approval,
          },
        ],
        [
          "approval.answered · answered",
          { bot: "assistant", approval, answer: "yes", by: "person" },
        ],
        [
          "run · allow",
          {
            bot: "assistant",
            command: "rm notes.txt",
            rule: "granted-tools",
            asked: "ask-before-rm",
            approval,
          },
        ],
        ["run · succeeded", { bot: "assistant" }],
      ]);

      const waited = tracing.spans.find((span) => span.name === "Gateway.awaitApproval");
      expect(waited?.attributes.get("gateway.rule")).toBe("ask-before-rm");
      expect(waited?.attributes.get("approval.answer")).toBe("yes");
      expect(waited?.attributes.get("approval.by")).toBe("person");

      const acted = tracing.spans.find((span) => span.name === "Gateway.act");
      expect(acted?.attributes.get("gateway.asked")).toBe("ask-before-rm");
      expect(acted?.attributes.get("gateway.decision")).toBe("allow");
      expect(acted?.attributes.get("gateway.outcome")).toBe("succeeded");
    }).pipe(Effect.provide(database)),
  );

  it.effect(
    "shows the question to the turn's person only, and takes no answer from anyone else",
    () =>
      Effect.gen(function* () {
        const acting = yield* actInBackground(firstRun, removeNotes);
        const shown = yield* untilShown();

        expect(yield* shownNow(bob)).toEqual(Option.none());
        expect(yield* Effect.flip(answerTo(shown, "yes", bob))).toBeInstanceOf(NoApprovalWaiting);

        yield* answerTo(shown, "yes");
        yield* Fiber.join(acting);

        const rows = yield* auditRows;
        expect(
          rows.map((row) => [
            `${String(row["action"])} · ${String(row["decision"])}`,
            row["actor_id"],
          ]),
        ).toEqual([
          ["run · ask", "alice@example.com"],
          ["approval.answered · answered", "alice@example.com"],
          ["run · allow", "alice@example.com"],
          ["run · succeeded", "alice@example.com"],
        ]);
      }).pipe(Effect.provide(startGateway(shell().layer, askBeforeRm)), Effect.provide(database)),
  );

  it.effect("shows the whole command as the Bot wrote it, while its rows keep it redacted", () =>
    Effect.gen(function* () {
      const computer = shell();
      const command = 'API_TOKEN="$(find . -name notes.txt -delete)"';

      const askBeforeDelete = policyFrom(`deny: []
allow:
  - name: granted-tools
    when: "true"
ask:
  - name: ask-before-delete
    when: command.contains("delete")
`);

      const { shown } = yield* askAndAnswer(firstRun, { action: "run", command }, "no").pipe(
        Effect.provide(startGateway(computer.layer, askBeforeDelete)),
      );

      expect(shown.question).toBe(`Run \`${command}\`?`);
      expect((yield* decodedTrail)[0]).toEqual([
        "run · ask",
        {
          bot: "assistant",
          command: 'API_TOKEN="[33 chars]"',
          rule: "ask-before-delete",
          allowedBy: "granted-tools",
          approval: shown.approval,
        },
      ]);
    }).pipe(Effect.provide(database)),
  );

  it.effect("refuses an action its person says no to, and never sends it to the computer", () =>
    Effect.gen(function* () {
      const computer = shell();

      const { shown, result } = yield* askAndAnswer(firstRun, removeNotes, "no").pipe(
        Effect.provide(startGateway(computer.layer, askBeforeRm)),
      );

      expect(computer.actions).toEqual([]);
      expect(refusalOf(result)).toEqual(
        "run did not run: your person said no. Do not try it, or another way to do it, until they write to you; tell them it did not run.",
      );
      expect((yield* decodedTrail).slice(1)).toEqual([
        [
          "approval.answered · answered",
          { bot: "assistant", approval: shown.approval, answer: "no", by: "person" },
        ],
        [
          "run · deny",
          {
            bot: "assistant",
            command: "rm notes.txt",
            rule: "ask-before-rm",
            approval: shown.approval,
            reason: "declined",
          },
        ],
      ]);
    }).pipe(Effect.provide(database)),
  );

  it.effect("counts no answer within the time limit as no, and takes no answer after it", () =>
    Effect.gen(function* () {
      const computer = shell();
      const tracing = recordedSpans();

      const [shown, result, late] = yield* Effect.gen(function* () {
        const acting = yield* actInBackground(firstRun, removeNotes);
        const shown = yield* untilShown();
        yield* TestClock.adjust(approvalWaitLimit);
        const result = yield* Fiber.join(acting);

        return [shown, result, yield* Effect.flip(answerTo(shown, "yes"))] as const;
      }).pipe(
        Effect.provide(startGateway(computer.layer, askBeforeRm)),
        Effect.provide(tracing.layer),
      );

      expect(computer.actions).toEqual([]);
      expect(refusalOf(result)).toContain(
        "your person did not answer within 10m, which counts as no.",
      );
      expect(late._tag).toBe("NoApprovalWaiting");
      expect((yield* decodedTrail).slice(1)).toEqual([
        [
          "approval.answered · answered",
          { bot: "assistant", approval: shown.approval, answer: "no", by: "time limit" },
        ],
        [
          "run · deny",
          {
            bot: "assistant",
            command: "rm notes.txt",
            rule: "ask-before-rm",
            approval: shown.approval,
            reason: "no answer",
          },
        ],
      ]);

      const waited = tracing.spans.find((span) => span.name === "Gateway.awaitApproval");
      expect(waited?.attributes.get("approval.by")).toBe("time limit");
    }).pipe(Effect.provide(database)),
  );

  it.effect(
    "refuses an equivalent action without a card after a no, for the rest of the run only",
    () =>
      Effect.gen(function* () {
        const computer = shell();

        const { again, shownAfter, nextRun } = yield* Effect.gen(function* () {
          yield* askAndAnswer(firstRun, removeNotes, "no");

          const again = yield* Gateway.use((gateway) =>
            Effect.flip(gateway.act(firstRun, { action: "run", command: "rm ./notes.txt" })),
          );

          const shownAfter = yield* shownNow();
          const nextRun = yield* askAndAnswer(inRun("run-2"), removeNotes, "yes");

          return { again, shownAfter, nextRun };
        }).pipe(Effect.provide(startGateway(computer.layer, askBeforeRm)));

        expect(again.message).toBe(
          "run did not run: your person already said no to this in this conversation. Do not ask again until they write to you.",
        );
        expect(shownAfter).toEqual(Option.none());
        expect(refusalOf(nextRun.result)).toBe("");
        expect(computer.actions).toEqual([removeNotes]);
        expect((yield* decodedTrail).map(([row]) => row)).toEqual([
          "run · ask",
          "approval.answered · answered",
          "run · deny",
          "run · deny",
          "run · ask",
          "approval.answered · answered",
          "run · allow",
          "run · succeeded",
        ]);
      }).pipe(Effect.provide(database)),
  );

  it.effect("shows one card for two calls at once, and refuses the second while it waits", () =>
    Effect.gen(function* () {
      const computer = shell();

      const [second, result] = yield* Effect.gen(function* () {
        const first = yield* actInBackground(firstRun, removeNotes);
        const shown = yield* untilShown();

        const second = yield* Gateway.use((gateway) =>
          Effect.flip(gateway.act(firstRun, { action: "run", command: "rm todo.txt" })),
        );

        yield* answerTo(shown, "yes");

        return [second, yield* Fiber.join(first)] as const;
      }).pipe(Effect.provide(startGateway(computer.layer, askBeforeRm)));

      expect(second.message).toBe(
        "run did not run: you already asked your person and they have not answered. Wait for that answer.",
      );
      expect(refusalOf(result)).toBe("");
      expect(computer.actions).toEqual([removeNotes]);
    }).pipe(Effect.provide(database)),
  );

  it.effect("refuses a yes for an element the page no longer shows under its ref", () =>
    Effect.gen(function* () {
      const page =
        (snapshot: string) =>
        (action: PageAction): Effect.Effect<PageRead> =>
          Effect.succeed({
            action: action.action,
            url: "https://example.com/notes",
            title: "Notes",
            snapshot,
            truncated: false,
          });

      let snapshot = '- button "Delete" [ref=e3]';
      const computer = fakeComputers({ browse: (action) => page(snapshot)(action) });

      const [result, clicked] = yield* Effect.gen(function* () {
        yield* Gateway.use((gateway) => gateway.act(firstRun, { action: "snapshot" }));

        const acting = yield* actInBackground(firstRun, { action: "click", ref: "e3" });
        const shown = yield* untilShown();

        snapshot = '- button "Delete everything" [ref=e3]';
        yield* Gateway.use((gateway) => gateway.act(firstRun, { action: "snapshot" }));
        yield* answerTo(shown, "yes");

        return [yield* Fiber.join(acting), shown] as const;
      }).pipe(Effect.provide(startGateway(computer.layer, askBeforeRm)));

      expect(clicked.question).toBe('Click the button "Delete" on example.com?');
      expect(refusalOf(result)).toEqual(
        "click did not run: what it acts on changed after your person answered, so their answer does not cover it. Take a snapshot and ask again.",
      );
      expect(computer.actions.map((action) => action.action)).toEqual(["snapshot", "snapshot"]);
      expect((yield* decodedTrail).at(-1)).toEqual([
        "click · deny",
        {
          bot: "assistant",
          ref: "e3",
          role: "button",
          name: "Delete everything",
          host: "example.com",
          rule: "ask-before-rm",
          approval: clicked.approval,
          reason: "action changed",
        },
      ]);
    }).pipe(Effect.provide(database)),
  );

  it.effect("hands a yes to the person once the page moved on to one that is theirs", () =>
    Effect.gen(function* () {
      let url = "https://example.com/notes";

      const computer = fakeComputers({
        browse: (action) =>
          Effect.succeed({
            action: action.action,
            url,
            title: "Notes",
            snapshot: '- button "Delete" [ref=e3]',
            truncated: false,
          }),
      });

      const [result, clicked] = yield* Effect.gen(function* () {
        yield* Gateway.use((gateway) => gateway.act(firstRun, { action: "snapshot" }));

        const acting = yield* actInBackground(firstRun, { action: "click", ref: "e3" });
        const shown = yield* untilShown();

        url = "https://example.com/settings/security";
        yield* Gateway.use((gateway) => gateway.act(firstRun, { action: "snapshot" }));
        yield* answerTo(shown, "yes");

        return [yield* Fiber.join(acting), shown] as const;
      }).pipe(Effect.provide(startGateway(computer.layer, askBeforeRm)));

      expect(refusalOf(result)).toContain("click did not run: changing a security setting");
      expect(computer.actions.map((action) => action.action)).toEqual(["snapshot", "snapshot"]);
      expect((yield* decodedTrail).at(-1)).toEqual([
        "click · hand_off",
        {
          bot: "assistant",
          ref: "e3",
          role: "button",
          name: "Delete",
          host: "example.com",
          rule: "ask-before-rm",
          approval: clicked.approval,
          path: "/settings/security",
          safety: "security",
        },
      ]);
      expect(yield* ledger).toEqual(["lapsed"]);
    }).pipe(Effect.provide(database)),
  );

  it.effect("refuses a yes once a person took the computer, naming the approval", () =>
    Effect.gen(function* () {
      const computer = shell();

      const [shown, result] = yield* Effect.gen(function* () {
        const acting = yield* actInBackground(firstRun, removeNotes);
        const shown = yield* untilShown();
        yield* ComputerControl.use((control) => control.take);
        yield* answerTo(shown, "yes");

        return [shown, yield* Fiber.join(acting)] as const;
      }).pipe(Effect.provide(startGateway(computer.layer, askBeforeRm)));

      expect(computer.actions).toEqual([]);
      expect(refusalOf(result)).toBe(
        "run did not run: a person has control of your computer. Wait until they hand it back, then take a snapshot.",
      );
      expect((yield* decodedTrail).at(-1)).toEqual([
        "run · deny",
        {
          bot: "assistant",
          command: "rm notes.txt",
          rule: "ask-before-rm",
          approval: shown.approval,
          reason: "a person has control",
        },
      ]);
    }).pipe(Effect.provide(database)),
  );

  it.effect("refuses an approved command whose turn was stopped while it waited its turn", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();

      const computer = fakeComputers({
        run: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as({
              action: "run" as const,
              end: CommandEnd.cases.Exited.make({ code: 0 }),
              stdout: { text: "", truncated: false },
              stderr: { text: "", truncated: false },
              leftOutputOpen: false,
            }),
          ),
      });

      const shown = yield* Effect.gen(function* () {
        const acting = yield* actInBackground(firstRun, removeNotes);
        const shown = yield* untilShown();
        const long = yield* actInBackground(firstRun, { action: "run", command: "sleep 100" });
        yield* Deferred.await(started);
        yield* answerTo(shown, "yes");
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(acting);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(long);

        return shown;
      }).pipe(Effect.provide(startGateway(computer.layer, askBeforeRm)));

      expect(computer.actions).toEqual([{ action: "run", command: "sleep 100" }]);
      expect(
        (yield* decodedTrail).filter(([, detail]) => detail.approval === shown.approval),
      ).toEqual([
        [
          "run · ask",
          {
            bot: "assistant",
            command: "rm notes.txt",
            rule: "ask-before-rm",
            allowedBy: "granted-tools",
            approval: shown.approval,
          },
        ],
        [
          "approval.answered · answered",
          { bot: "assistant", approval: shown.approval, answer: "yes", by: "person" },
        ],
        [
          "run · deny",
          {
            bot: "assistant",
            command: "rm notes.txt",
            rule: "ask-before-rm",
            approval: shown.approval,
            reason: "the turn was stopped",
          },
        ],
      ]);
    }).pipe(Effect.provide(database)),
  );

  it.effect(
    "never runs an approved action twice after a restart, and tells the next run once",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();

        const hanging = fakeComputers({
          run: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        });

        yield* Effect.gen(function* () {
          const acting = yield* actInBackground(firstRun, removeNotes);
          yield* answerTo(yield* untilShown(), "yes");
          yield* Deferred.await(started);
          yield* Fiber.interrupt(acting);
        }).pipe(Effect.provide(startGateway(hanging.layer, askBeforeRm)));

        const computer = shell();
        const nextRun = inRun("run-2");

        const [told, shownAfter, asked] = yield* Effect.gen(function* () {
          const told = yield* Gateway.use((gateway) =>
            Effect.flip(gateway.act(nextRun, removeNotes)),
          );

          const shownAfter = yield* shownNow();

          return [told, shownAfter, yield* askAndAnswer(nextRun, removeNotes, "yes")] as const;
        }).pipe(Effect.provide(startGateway(computer.layer, askBeforeRm)));

        expect(hanging.actions).toEqual([removeNotes]);
        expect(told.message).toBe(outcomeUnknown);
        expect(shownAfter).toEqual(Option.none());
        expect(refusalOf(asked.result)).toBe("");
        expect(computer.actions).toEqual([removeNotes]);
        expect((yield* decodedTrail).map(([row, detail]) => [row, detail.reason])).toEqual([
          ["run · ask", undefined],
          ["approval.answered · answered", undefined],
          ["run · allow", undefined],
          ["run · unknown", "the turn was stopped"],
          ["run · deny", "outcome unknown"],
          ["run · ask", undefined],
          ["approval.answered · answered", undefined],
          ["run · allow", undefined],
          ["run · succeeded", undefined],
        ]);
      }).pipe(Effect.provide(database)),
  );

  it.effect("tells the next run an approved action's outcome is unknown after a stop", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();

      const computer = fakeComputers({
        run: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      });

      const told = yield* Effect.gen(function* () {
        const acting = yield* actInBackground(firstRun, removeNotes);
        yield* answerTo(yield* untilShown(), "yes");
        yield* Deferred.await(started);
        yield* Fiber.interrupt(acting);

        return yield* Gateway.use((gateway) =>
          Effect.flip(gateway.act(inRun("run-2"), { action: "run", command: "rm todo.txt" })),
        );
      }).pipe(Effect.provide(startGateway(computer.layer, askBeforeRm)));

      expect(told.message).toBe(outcomeUnknown);
      expect(computer.actions).toEqual([removeNotes]);
    }).pipe(Effect.provide(database)),
  );

  it.effect("answers no to a question a stopped server left open, and refuses it, once", () =>
    Effect.gen(function* () {
      // The first server stops while the card is up, without running a finalizer, as a crash does: its
      // call is detached, so closing its layer interrupts nothing.
      const shown = yield* Effect.gen(function* () {
        yield* Gateway.use((gateway) =>
          Effect.forkDetach(Effect.result(gateway.act(firstRun, removeNotes))),
        );

        return yield* untilShown();
      }).pipe(Effect.provide(startGateway(shell().layer, askBeforeRm)));

      const restart = Effect.provide(Effect.void, startGateway(shell().layer, askBeforeRm));
      yield* restart;
      yield* restart;

      expect(
        (yield* decodedTrail).filter(([, detail]) => detail.approval === shown.approval).slice(1),
      ).toEqual([
        [
          "approval.answered · answered",
          { bot: "assistant", approval: shown.approval, answer: "no", by: "the server stopped" },
        ],
        [
          "run · deny",
          {
            bot: "assistant",
            rule: "ask-before-rm",
            approval: shown.approval,
            reason: "the server stopped",
          },
        ],
      ]);
    }).pipe(Effect.provide(database)),
  );

  it.effect("closes a question a stopped server left open in the name of the person it asked", () =>
    Effect.gen(function* () {
      const shown = yield* Effect.gen(function* () {
        yield* Gateway.use((gateway) =>
          Effect.forkDetach(Effect.result(gateway.act(firstRun, removeNotes))),
        );

        return yield* untilShown();
      }).pipe(Effect.provide(startGateway(shell().layer, askBeforeRm)));

      yield* Effect.provide(Effect.void, startGateway(shell().layer, askBeforeRm));

      const rows = (yield* auditRows).filter((row) =>
        String(row["detail"]).includes(shown.approval),
      );

      expect(
        rows.map((row) => [
          `${String(row["action"])} · ${String(row["decision"])}`,
          row["initiator_kind"],
          row["actor_id"],
        ]),
      ).toEqual([
        ["run · ask", "person", "alice@example.com"],
        ["approval.answered · answered", "deployment", "alice@example.com"],
        ["run · deny", "deployment", "alice@example.com"],
      ]);
    }).pipe(Effect.provide(database)),
  );

  it.effect("records no and refuses a question whose turn was stopped while it waited", () =>
    Effect.gen(function* () {
      const computer = shell();

      const shown = yield* Effect.gen(function* () {
        const acting = yield* actInBackground(firstRun, removeNotes);
        const shown = yield* untilShown();
        yield* Fiber.interrupt(acting);

        return shown;
      }).pipe(Effect.provide(startGateway(computer.layer, askBeforeRm)));

      expect(computer.actions).toEqual([]);
      expect((yield* decodedTrail).slice(1)).toEqual([
        [
          "approval.answered · answered",
          { bot: "assistant", approval: shown.approval, answer: "no", by: "the turn was stopped" },
        ],
        [
          "run · deny",
          {
            bot: "assistant",
            command: "rm notes.txt",
            rule: "ask-before-rm",
            approval: shown.approval,
            reason: "the turn was stopped",
          },
        ],
      ]);
    }).pipe(Effect.provide(database)),
  );

  it.effect("asks nothing of an action no ask rule holds for", () =>
    Effect.gen(function* () {
      const computer = shell();

      yield* Gateway.use((gateway) => gateway.act(firstRun, { action: "run", command: "ls" })).pipe(
        Effect.provide(startGateway(computer.layer, askBeforeRm)),
      );

      expect((yield* decodedTrail).map(([row]) => row)).toEqual(["run · allow", "run · succeeded"]);
    }).pipe(Effect.provide(database)),
  );
});

describe("Gateway asking the person, when a row cannot be written", () => {
  it.effect("keeps a question open in the ledger until a start-up can close it in the trail", () =>
    Effect.gen(function* () {
      const shown = yield* Effect.gen(function* () {
        yield* Gateway.use((gateway) =>
          Effect.forkDetach(Effect.result(gateway.act(firstRun, removeNotes))),
        );

        return yield* untilShown();
      }).pipe(Effect.provide(startGateway(shell().layer, askBeforeRm)));

      const restart = Effect.provide(Effect.void, startGateway(shell().layer, askBeforeRm));

      yield* failAuditRowsWhere("NEW.initiator_kind = 'deployment'");
      yield* restart;
      yield* healAuditRows;

      expect(yield* ledger).toEqual(["asked"]);

      yield* restart;
      yield* restart;

      expect(yield* ledger).toEqual(["no"]);
      expect(yield* rowsOf(shown.approval)).toEqual([
        ["run · ask", undefined],
        ["approval.answered · answered", undefined],
        ["run · deny", "the server stopped"],
      ]);
    }).pipe(Effect.provide(database)),
  );

  it.effect("refuses a yes whose allow row cannot be written, and closes it in the trail", () =>
    Effect.gen(function* () {
      const computer = shell();

      const { shown, result } = yield* Effect.gen(function* () {
        yield* failAuditRowsWhere("NEW.decision = 'allow'");
        const asked = yield* askAndAnswer(firstRun, removeNotes, "yes");
        yield* healAuditRows;

        return asked;
      }).pipe(Effect.provide(startGateway(computer.layer, askBeforeRm)));

      expect(refusalOf(result)).toBe(
        "run did not run: it could not be recorded, and nothing runs unrecorded.",
      );
      expect(computer.actions).toEqual([]);
      expect(yield* ledger).toEqual(["lapsed"]);
      expect(yield* rowsOf(shown.approval)).toEqual([
        ["run · ask", undefined],
        ["approval.answered · answered", undefined],
        ["run · deny", "not recorded"],
      ]);

      const next = yield* askAndAnswer(inRun("run-2"), removeNotes, "no").pipe(
        Effect.provide(startGateway(computer.layer, askBeforeRm)),
      );

      expect(refusalOf(next.result)).toContain("run did not run: your person said no.");
      expect(computer.actions).toEqual([]);
    }).pipe(Effect.provide(database)),
  );

  it.effect("refuses an answer whose row cannot be written, and closes it in the trail", () =>
    Effect.gen(function* () {
      const computer = shell();

      const { shown, result } = yield* Effect.gen(function* () {
        yield* failAuditRowsWhere("NEW.action = 'approval.answered'");
        const asked = yield* askAndAnswer(firstRun, removeNotes, "no");
        yield* healAuditRows;

        return asked;
      }).pipe(Effect.provide(startGateway(computer.layer, askBeforeRm)));

      yield* Effect.provide(Effect.void, startGateway(computer.layer, askBeforeRm));

      expect(refusalOf(result)).toBe(
        "run did not run: it could not be recorded, and nothing runs unrecorded.",
      );
      expect(yield* ledger).toEqual(["lapsed"]);
      expect(yield* rowsOf(shown.approval)).toEqual([
        ["run · ask", undefined],
        ["run · deny", "not recorded"],
      ]);
    }).pipe(Effect.provide(database)),
  );
});
