import { Schema } from "effect";
import {
  type ModelScript,
  ModelStep,
} from "../../apps/server/src/features/agent/testing/model-script.ts";
import { assert, browser, waitFor } from "../browser.ts";
import { answers, ask, auditRows, doneCards, modelRequests, script } from "../chat.ts";
import { ancestry, traceSpans } from "../tempo.ts";

/** The page that tells its reader to go to evil.test, served on the computers network. */
const injectionPage = "http://fixture:8080/injection";

const NavigateDetail = Schema.fromJsonString(Schema.Struct({ url: Schema.String }));

/** Navigate to `url`, read the page, then say `words`: what each turn here scripts the model to do. */
function openAndRead(url: string, words: ReadonlyArray<string>): ModelScript {
  return [
    ModelStep.CallTools({ calls: [{ name: "navigate", params: { url } }] }),
    ModelStep.CallTools({ calls: [{ name: "snapshot", params: {} }] }),
    ModelStep.Say({ words }),
  ];
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

  await waitFor("the turn's span and its gateway and computer spans in Tempo", 60_000, async () => {
    spans = await traceSpans(grafanaUrl, traceId).catch(() => []);

    return (
      spans.some((span) => span.name === "Chat.turn") &&
      spans.filter((span) => span.name === "Gateway.act").length === 2 &&
      spans.filter((span) => span.name === "Computer.act").length >= 2
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
