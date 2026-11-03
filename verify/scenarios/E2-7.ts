import { Schema } from "effect";
import { ModelStep } from "../../apps/server/src/features/agent/testing/model-script.ts";
import { assert, browser, evaluate, waitFor } from "../browser.ts";
import { answers, auditRows, idle, script, send, turnEnded } from "../chat.ts";
import { slowPageDelayMs } from "../slow-page.ts";
import { attribute, type TempoSpan, traceSpans } from "../tempo.ts";

const paused = "This Bot is paused.";

const greeting = "I am back.";

const Detail = Schema.fromJsonString(
  Schema.Struct({ bot: Schema.String, reason: Schema.optional(Schema.String) }),
);

const ShownRows = Schema.Array(Schema.Struct({ shown: Schema.String, why: Schema.String }));

/** Ten model steps, each opening the next slow page, then a word to close. */
function tenPages() {
  return script([
    ...Array.from({ length: 10 }, (_, index) =>
      ModelStep.CallTools({
        calls: [{ name: "navigate", params: { url: `http://fixture:8080/slow/${index + 1}` } }],
      }),
    ),
    ModelStep.Say({ words: ["Opened", " all", " ten."] }),
  ]);
}

/** How many navigate cards the transcript draws, running or not. */
function navigateCards(): number {
  return Number(browser("get", "count", '.tool-call[data-tool="navigate"]'));
}

/** The message under the transcript that says why the conversation stopped, or "" without one. */
function conversationError(): string {
  return evaluate(
    Schema.String,
    `document.querySelector(".conversation__error")?.textContent ?? ""`,
  );
}

/** What the composer holds. */
function draft(): string {
  return evaluate(Schema.String, `document.querySelector(".composer__input")?.value ?? ""`);
}

/** Whether the header says the Bot is paused. */
function showsPaused(): boolean {
  return browser("get", "count", ".pill__badge") === "1";
}

/** The audit trail as `action · decision`, oldest first. */
function trail(): ReadonlyArray<string> {
  return auditRows().map((row) => `${row.action} · ${row.decision}`);
}

/** The reason each audit row of `action` with `decision` names, oldest first. */
function reasons(action: string, decision: string): ReadonlyArray<string> {
  return auditRows()
    .filter((row) => row.action === action && row.decision === decision)
    .map((row) => Schema.decodeUnknownSync(Detail)(row.detail).reason ?? "");
}

/**
E2-7: Assistant opens ten slow pages one by one. The person presses Stop while the second opens: the turn
ends, no third `navigate` row is ever written, the stop is audited as `turn.stopped` by the person, and the
turn's `Chat.turn` span in Tempo has `chat.status = cancelled`. Asked again, Assistant starts on the pages
and the person presses Pause in the header: the running turn ends with "This Bot is paused.", and the pill
says Paused. A message sent now is refused with the same words, goes back into the composer, and is audited
as `turn · deny` with `bot paused`. Resume, send it again, and Assistant answers. The audit page reads
Stop a turn, Pause a Bot, Start a turn · Refused (bot paused) and Resume a Bot.
*/
export default async function scenario(baseUrl: string, grafanaUrl: string): Promise<void> {
  await tenPages();

  browser("open", baseUrl);
  browser("wait", "--load", "networkidle");
  browser("set", "media", "dark", "reduced-motion");

  await turnEnded();
  send("Open the ten pages one by one.");

  await waitFor("the second page to be opening", 60_000, () => navigateCards() === 2);
  browser("find", "role", "button", "click", "--name", "Stop");
  await waitFor("the turn to stop", 30_000, idle);
  // Had the turn gone on, the second page would have opened by now and the third navigate been asked for.
  await new Promise((resolve) => setTimeout(resolve, slowPageDelayMs + 5_000));

  const navigations = auditRows().filter(
    (row) => row.action === "navigate" && row.decision === "allow",
  );

  assert(
    navigations.length === 2 && navigateCards() === 2,
    `the turn stopped on the second page, and no third navigate row appeared (${trail().join(", ")})`,
  );
  assert(
    reasons("turn.stopped", "allow").join() === "stopped by the person" &&
      trail().includes("turn.stopped · succeeded"),
    `the stop is audited as turn.stopped by the person (${trail().join(", ")})`,
  );

  const traceId = navigations[0]?.trace_id ?? "";
  let spans: ReadonlyArray<TempoSpan> = [];

  await waitFor("the stopped turn's Chat.turn span in Tempo", 60_000, async () => {
    spans = await traceSpans(grafanaUrl, traceId).catch(() => []);

    return spans.some((span) => span.name === "Chat.turn");
  });

  const turn = spans.find((span) => span.name === "Chat.turn");
  assert(
    turn !== undefined && attribute(turn, "chat.status") === "cancelled",
    `the stopped turn's span says cancelled (${JSON.stringify(turn?.attributes)})`,
  );

  await tenPages();
  send("Open them again, please.");
  await waitFor(
    "the first page of the new turn to be opening",
    60_000,
    () => navigateCards() === 3,
  );

  browser("find", "role", "button", "click", "--name", "Pause");
  await waitFor(
    "the pause to end the running turn",
    30_000,
    () => idle() && conversationError() === paused,
  );
  await waitFor("the header to say Paused", 10_000, showsPaused);
  assert(
    reasons("turn.stopped", "allow").at(-1) === "bot paused" &&
      trail().includes("bot.paused · succeeded"),
    `the pause is audited and stopped the running turn (${trail().join(", ")})`,
  );

  const knocking = "Are you there?";
  send(knocking);
  await waitFor("the message to come back into the composer", 30_000, () => draft() === knocking);
  assert(conversationError() === paused, `the refused message says "${paused}"`);
  assert(
    reasons("turn", "deny").join() === "bot paused",
    `the refused turn is audited as turn · deny, bot paused (${trail().join(", ")})`,
  );

  await script([ModelStep.Say({ words: greeting.split(/(?= )/u) })]);
  browser("find", "role", "button", "click", "--name", "Resume");
  await waitFor("the header to stop saying Paused", 10_000, () => !showsPaused());
  send(knocking);
  await waitFor("Assistant to answer again", 60_000, () => answers().at(-1) === greeting);
  assert(trail().includes("bot.resumed · succeeded"), "the resume is audited");

  browser("find", "role", "link", "click", "--name", "Audit trail");
  await waitFor("the audit page to show the resume", 30_000, () =>
    shownRows().some((row) => row.shown === "Resume a Bot · Allowed"),
  );

  const shown = shownRows();

  const reads = (text: string, why = "") =>
    shown.some((row) => row.shown === text && row.why.includes(why));

  assert(
    reads("Stop a turn · Allowed", "stopped by the person") &&
      reads("Pause a Bot · Allowed") &&
      reads("Start a turn · Refused", "bot paused") &&
      reads("Resume a Bot · Allowed"),
    `the audit page reads each step in words (${JSON.stringify(shown.slice(0, 12))})`,
  );
}

/** Every row the audit page shows, as a person reads it. */
function shownRows() {
  return evaluate(
    ShownRows,
    `[...document.querySelectorAll(".audit__row")].map((row) => ({
      shown: row.cells[3].textContent + " · " + row.cells[4].textContent,
      why: row.cells[5].textContent,
    }))`,
  );
}
