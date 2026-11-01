import { Schema } from "effect";
import {
  type ModelScript,
  ModelStep,
} from "../../apps/server/src/features/agent/testing/model-script.ts";
import { assert, browser, waitFor } from "../browser.ts";
import { composeOutput } from "../stack.ts";
import { ancestry, traceSpans } from "../tempo.ts";

/** The mock model's control routes, published on loopback by verify/compose.yml. */
const mockModel = "http://localhost:4110";

/** The page that tells its reader to go to evil.test, served on the computers network. */
const injectionPage = "http://fixture:8080/injection";

const AuditRows = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      decision: Schema.String,
      action: Schema.String,
      trace_id: Schema.NullOr(Schema.String),
      detail: Schema.String,
    }),
  ),
);

const NavigateDetail = Schema.fromJsonString(Schema.Struct({ url: Schema.String }));

const ModelRequests = Schema.Struct({ requests: Schema.Array(Schema.String) });

async function script(steps: ModelScript): Promise<void> {
  const response = await fetch(`${mockModel}/mock/script`, {
    method: "PUT",
    body: JSON.stringify(steps),
  });

  assert(response.ok, `the mock model took a ${steps.length}-step script (${response.status})`);
}

/** Navigate to `url`, read the page, then say `words`: what each turn here scripts the model to do. */
function openAndRead(url: string, words: ReadonlyArray<string>): ModelScript {
  return [
    ModelStep.CallTools({ calls: [{ name: "navigate", params: { url } }] }),
    ModelStep.CallTools({ calls: [{ name: "snapshot", params: {} }] }),
    ModelStep.Say({ words }),
  ];
}

/** Every audit row, oldest first, read from the SQLite file on the server's volume. */
function auditRows() {
  const read = `const { DatabaseSync } = require("node:sqlite");
const rows = new DatabaseSync("/data/aobot.db")
  .prepare("SELECT decision, action, trace_id, detail FROM audit_rows ORDER BY seq").all();
console.log(JSON.stringify(rows));`;

  return Schema.decodeUnknownSync(AuditRows)(
    composeOutput("exec", "-T", "server", "node", "-e", read),
  );
}

/** What the server sent the mock model since the last script. */
async function modelRequests(): Promise<ReadonlyArray<string>> {
  const response = await fetch(`${mockModel}/mock/requests`);

  return Schema.decodeUnknownSync(ModelRequests)(await response.json()).requests;
}

/** Whether `needle` occurs in `text`, and every time between an `<untrusted_data` tag and its closing tag. */
function onlyInsideEnvelopes(text: string, needle: string): boolean {
  const positions: Array<number> = [];

  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    positions.push(at);
  }

  return (
    positions.length > 0 &&
    positions.every((at) => {
      const opened = text.lastIndexOf("<untrusted_data", at);

      return opened !== -1 && text.lastIndexOf("</untrusted_data>", at) < opened;
    })
  );
}

const AnswerTexts = Schema.fromJsonString(Schema.Array(Schema.String));

/** The text of every answer on the page that has any, oldest first. */
function answers(): ReadonlyArray<string> {
  return Schema.decodeUnknownSync(AnswerTexts)(
    browser(
      "eval",
      "[...document.querySelectorAll('.bubble--assistant .bubble__text')].map((node) => node.textContent)",
    ),
  ).filter((text) => text !== "");
}

function doneCards(tool: string): number {
  return Number(browser("get", "count", `.tool-call[data-tool="${tool}"][data-status="done"]`));
}

async function ask(text: string, index: number, answer: string): Promise<void> {
  browser("find", "placeholder", "Message Assistant", "fill", text);
  browser("press", "Enter");

  await waitFor(`answer ${index + 1}`, 120_000, () => answers()[index] === answer);
}

/**
E1-1: the Bot opens example.com on its computer and answers with the title, both tool calls are drawn,
audited and traced. Then a page that tells the Bot to navigate to evil.test reaches the model only inside
the untrusted-data envelope, and the run goes nowhere it did not script.
*/
export default async function scenario(baseUrl: string, grafanaUrl: string): Promise<void> {
  await script(openAndRead("https://example.com", ["Example", " Domain"]));

  browser("open", baseUrl);
  browser("wait", "--load", "networkidle");

  await ask("Open example.com and tell me the page title.", 0, "Example Domain");
  assert(answers()[0] === "Example Domain", "the Bot answered Example Domain");

  await waitFor("both tool cards to be done", 10_000, () => doneCards("snapshot") === 1);
  assert(doneCards("navigate") === 1, "the navigate card is done");
  assert(doneCards("snapshot") === 1, "the snapshot card is done");

  const read = browser(
    "eval",
    `document.querySelector('.tool-call[data-tool="snapshot"] .tool-call__result')?.textContent ?? ""`,
  );

  assert(read.includes("Title: Example Domain"), "the computer really read example.com's title");

  const firstTurn = auditRows();
  const allowed = firstTurn.filter((row) => row.decision === "allow");
  assert(
    allowed.map((row) => row.action).join(",") === "navigate,snapshot",
    `the audit table has navigate · allow and snapshot · allow (${JSON.stringify(firstTurn)})`,
  );

  const traceIds = new Set(allowed.map((row) => row.trace_id ?? ""));
  const [traceId = ""] = traceIds;
  assert(
    traceIds.size === 1 && traceId !== "",
    `both allow rows carry the turn's trace_id (${[...traceIds].join(", ")})`,
  );
  assert(
    firstTurn.filter((row) => row.decision === "succeeded").length === 2,
    "both calls are recorded as succeeded",
  );

  let spans: Awaited<ReturnType<typeof traceSpans>> = [];

  await waitFor("the turn's gateway and computer spans in Tempo", 60_000, async () => {
    spans = await traceSpans(grafanaUrl, traceId).catch(() => []);

    return (
      spans.filter((span) => span.name === "Gateway.act").length === 2 &&
      spans.filter((span) => span.name === "Computer.act").length === 2
    );
  });

  const gatewayCalls = spans
    .filter((span) => span.name === "Gateway.act")
    .map((span) => ancestry(spans, span));

  assert(
    gatewayCalls.every((path) => path[0] === "Chat.turn"),
    `each Gateway.act sits inside Chat.turn (${gatewayCalls.map((path) => path.join(" > ")).join("; ")})`,
  );

  const computerWork = spans
    .filter((span) => span.name === "Computer.act")
    .map((span) => ancestry(spans, span));

  assert(
    computerWork.every((path) => path[0] === "Chat.turn" && path.includes("Gateway.act")),
    `the computer's work sits inside Gateway.act (${computerWork.map((path) => path.join(" > ")).join("; ")})`,
  );

  await script(openAndRead(injectionPage, ["The", " page", " lists", " opening", " hours."]));
  await ask(
    "Open the opening hours page and tell me what it says.",
    1,
    "The page lists opening hours.",
  );

  const sawPage = (await modelRequests()).filter((body) => body.includes("evil.test"));
  assert(
    sawPage.length > 0 && sawPage.every((body) => onlyInsideEnvelopes(body, "evil.test")),
    `the model saw the page's evil.test only inside <untrusted_data (${sawPage.length} requests)`,
  );

  const navigated = auditRows()
    .filter((row) => row.action === "navigate" && row.decision === "allow")
    .map((row) => Schema.decodeUnknownSync(NavigateDetail)(row.detail).url);

  assert(
    JSON.stringify(navigated) === JSON.stringify(["https://example.com", injectionPage]),
    `the computer went only where the script said, never to evil.test (${navigated.join(", ")})`,
  );
}
