import { Schema } from "effect";
import { ModelStep } from "../../apps/server/src/features/agent/testing/model-script.ts";
import { assert, browser, evaluate, waitFor } from "../browser.ts";
import { answers, auditRows, modelRequests, script, send, turnEnded } from "../chat.ts";
import { panelState } from "../screen.ts";
import { attribute, type TempoSpan, traceSpans } from "../tempo.ts";

const removeNotes = "find . -name notes.txt -delete";

const question = `Run \`${removeNotes}\`?`;

const keptAnswer = "You said no, so notes.txt stays.";

const deletedAnswer = "I deleted notes.txt.";

const Answered = Schema.fromJsonString(
  Schema.Struct({ approval: Schema.String, answer: Schema.String, by: Schema.String }),
);

const Asked = Schema.fromJsonString(
  Schema.Struct({
    command: Schema.String,
    rule: Schema.String,
    allowedBy: Schema.String,
    approval: Schema.String,
  }),
);

const Allowed = Schema.fromJsonString(
  Schema.Struct({
    command: Schema.String,
    rule: Schema.String,
    asked: Schema.optional(Schema.String),
    approval: Schema.optional(Schema.String),
  }),
);

/** What each run card printed, oldest first, once it has a result. */
function runResults(): ReadonlyArray<string> {
  return evaluate(
    Schema.Array(Schema.String),
    `[...document.querySelectorAll('.tool-call[data-tool="run"] .tool-call__result')].map((node) => node.textContent ?? "")`,
  );
}

/** Whether `listing`, what `ls` printed, names notes.txt on a line of its own. */
function lists(listing: string): boolean {
  return /^notes\.txt$/mu.test(listing);
}

/** The approval card's text now, or "" while there is none. */
function approvalCard(): string {
  return evaluate(Schema.String, `document.querySelector(".approval")?.textContent ?? ""`);
}

/**
Waits for the approval card to ask its question below the run card of the `calls`th command, the one that
asked it, with the Bot's screen open and still, then answers it `answer`. The card and that run card reach
the page on two streams, and the screen slides open on a turn's first call, so until all three settle the
card can move from under a click aimed at it.
*/
async function answerCard(answer: "Yes" | "No", calls: number): Promise<void> {
  await waitFor(
    "the approval card to ask below the run card that asked it, beside a still screen",
    60_000,
    () =>
      browser("get", "count", ".approval .approval__answer") === "2" &&
      browser("get", "count", '.tool-call[data-tool="run"]') === String(calls) &&
      panelState() === "open" &&
      evaluate(Schema.Number, "document.getAnimations().length") === 0,
  );
  assert(
    approvalCard().startsWith(question),
    `the card asks the question the server worded from the command (${approvalCard()})`,
  );
  browser("find", "role", "button", "click", "--name", answer);
  await waitFor(`the card to take the answer ${answer}`, 10_000, () =>
    approvalCard().endsWith(`You answered ${answer}`),
  );
}

/**
E2-5: rules.yaml asks the person before a command that contains `delete`. Asked to write notes.txt and
delete it, the Bot writes it, then its delete waits on an approval card in the chat. The person answers
No: the command never runs, the Bot reads that the person said no, and notes.txt is still listed. The
person writes again and answers Yes: the command runs once and notes.txt is gone. The audit trail reads
`run · ask`, `approval.answered · answered`, then `run · deny` for the no and `run · allow` naming the
ask rule for the yes, and the wait is a `Gateway.awaitApproval` span in Tempo with the answer.
*/
export default async function scenario(baseUrl: string, grafanaUrl: string): Promise<void> {
  await script([
    ModelStep.CallTools({
      calls: [{ name: "run", params: { command: "echo hello > notes.txt" } }],
    }),
    ModelStep.CallTools({ calls: [{ name: "run", params: { command: removeNotes } }] }),
    ModelStep.CallTools({ calls: [{ name: "run", params: { command: "ls" } }] }),
    ModelStep.Say({ words: keptAnswer.split(/(?= )/u) }),
  ]);

  browser("open", baseUrl);
  browser("wait", "--load", "networkidle");

  send("Write notes.txt, then delete it.");
  await answerCard("No", 2);
  await waitFor("the Bot to say notes.txt stays", 120_000, () => answers()[0] === keptAnswer);

  const afterNo = runResults();
  assert(
    afterNo.length === 3 && afterNo[1]?.includes("your person said no") === true,
    `the delete card says the person said no (${JSON.stringify(afterNo)})`,
  );
  assert(lists(afterNo[2] ?? ""), `notes.txt stays after the no (${afterNo[2]})`);
  assert(
    (await modelRequests()).some((request) => request.includes("your person said no")),
    "the model read that its person said no",
  );
  await waitFor("the approval card to go once the turn ended", 30_000, () => approvalCard() === "");

  await script([
    ModelStep.CallTools({ calls: [{ name: "run", params: { command: removeNotes } }] }),
    ModelStep.CallTools({ calls: [{ name: "run", params: { command: "ls" } }] }),
    ModelStep.Say({ words: deletedAnswer.split(/(?= )/u) }),
  ]);

  await turnEnded();
  send("Yes, delete it now.");
  await answerCard("Yes", 4);
  await waitFor(
    "the Bot to say it deleted notes.txt",
    120_000,
    () => answers()[1] === deletedAnswer,
  );

  const afterYes = runResults();
  assert(
    afterYes.length === 5,
    `the second turn ran the delete and ls (${JSON.stringify(afterYes)})`,
  );
  assert(!lists(afterYes[4] ?? ""), `notes.txt is gone after the yes (${afterYes[4]})`);

  const rows = auditRows();
  const trail = rows.map((row) => `${row.action} · ${row.decision}`);
  assert(
    trail.join(", ") ===
      [
        "run · allow",
        "run · succeeded",
        "run · ask",
        "approval.answered · answered",
        "run · deny",
        "run · allow",
        "run · succeeded",
        "run · ask",
        "approval.answered · answered",
        "run · allow",
        "run · succeeded",
        "run · allow",
        "run · succeeded",
      ].join(", "),
    `the audit trail asks, records each answer, then refuses or allows (${trail.join(", ")})`,
  );

  const [askedNo, askedYes] = rows
    .filter((row) => row.decision === "ask")
    .map((row) => Schema.decodeUnknownSync(Asked)(row.detail));

  assert(
    askedNo?.rule === "ask-before-delete" &&
      askedNo.allowedBy === "granted-tools" &&
      askedNo.command === removeNotes,
    `run · ask names the ask rule, the allow rule and the command (${JSON.stringify(askedNo)})`,
  );

  const [no, yes] = rows
    .filter((row) => row.decision === "answered")
    .map((row) => Schema.decodeUnknownSync(Answered)(row.detail));

  assert(
    no?.answer === "no" && no.by === "person" && no.approval === askedNo.approval,
    `the first approval.answered records the person's no (${JSON.stringify(no)})`,
  );
  assert(
    yes?.answer === "yes" && yes.by === "person" && yes.approval === askedYes?.approval,
    `the second approval.answered records the person's yes (${JSON.stringify(yes)})`,
  );

  const deleted = rows
    .filter((row) => row.decision === "allow")
    .map((row) => Schema.decodeUnknownSync(Allowed)(row.detail))
    .find((detail) => detail.command === removeNotes);

  assert(
    deleted?.rule === "granted-tools" &&
      deleted.asked === "ask-before-delete" &&
      deleted.approval === yes.approval,
    `the delete's run · allow names the allow rule, the ask rule and the approval (${JSON.stringify(deleted)})`,
  );

  const traceId = rows.find((row) => row.decision === "ask")?.trace_id ?? "";
  assert(traceId !== "", "the ask row carries the turn's trace_id");

  let spans: ReadonlyArray<TempoSpan> = [];

  await waitFor("the Gateway.awaitApproval span in Tempo", 60_000, async () => {
    spans = await traceSpans(grafanaUrl, traceId).catch(() => []);

    return spans.some((span) => span.name === "Gateway.awaitApproval");
  });

  const waited = spans.find((span) => span.name === "Gateway.awaitApproval");
  assert(
    waited !== undefined &&
      attribute(waited, "approval.answer") === "no" &&
      attribute(waited, "approval.by") === "person" &&
      attribute(waited, "gateway.rule") === "ask-before-delete",
    `the wait is a span with the answer (${JSON.stringify(waited?.attributes)})`,
  );
}
