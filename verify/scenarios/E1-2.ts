import { Array, Option, Schema } from "effect";
import {
  jsonStrings,
  ModelStep,
  refTo,
} from "../../apps/server/src/features/agent/testing/model-script.ts";
import { assert, browser, waitFor } from "../browser.ts";
import { answers, ask, auditRows, doneCards, modelRequests, script } from "../chat.ts";
import { ancestry, traceSpans } from "../tempo.ts";

const portal = "https://www.wikipedia.org/";

const query = "Effect TypeScript";

const searchBox = refTo("searchbox", "Search Wikipedia");

const RefDetail = Schema.fromJsonString(
  Schema.Struct({
    ref: Schema.String,
    role: Schema.String,
    name: Schema.String,
    text: Schema.optional(Schema.String),
  }),
);

const decodeBody = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

/** A snapshot line that shows the search box holding the query. */
const holdsQuery = new RegExp(
  `^\\s*- searchbox "Search Wikipedia"(?: \\[[^\\]]+\\])* \\[ref=[^\\]]+\\](?: \\[[^\\]]+\\])*: ${query}$`,
  "mu",
);

/**
E1-2: asked to search Wikipedia for "Effect TypeScript" without submitting, the Bot opens the portal,
clicks the search box and types by the refs of the page it was shown. The page it reads back holds the
text and has not moved; both calls are drawn, audited with the element they acted on, and traced.
*/
export default async function scenario(baseUrl: string, grafanaUrl: string): Promise<void> {
  await script([
    ModelStep.CallTools({ calls: [{ name: "navigate", params: { url: portal } }] }),
    ModelStep.CallTools({ calls: [{ name: "click", params: { ref: searchBox } }] }),
    ModelStep.CallTools({ calls: [{ name: "type", params: { ref: searchBox, text: query } }] }),
    ModelStep.Say({ words: ["The", " search", " box", " holds", ` ${query}.`] }),
  ]);

  browser("open", baseUrl);
  browser("wait", "--load", "networkidle");

  await ask(
    `Search Wikipedia for "${query}", but do not submit the search.`,
    0,
    `The search box holds ${query}.`,
  );

  await waitFor("the click and type cards to be done", 10_000, () => doneCards("type") === 1);
  assert(doneCards("click") === 1, "the click card is done");

  // agent-browser prints what eval answers as JSON.
  const typedCard = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.String))(
    browser(
      "eval",
      `document.querySelector('.tool-call[data-tool="type"] .tool-call__result')?.textContent ?? ""`,
    ),
  );

  assert(holdsQuery.test(typedCard), `the transcript shows the search box holding "${query}"`);
  assert(typedCard.includes(`URL: ${portal}`), "typing did not submit the search");

  const requests = await modelRequests();

  const lastPage = Array.findLast(
    Option.match(decodeBody(requests.at(-1) ?? ""), { onNone: () => [], onSome: jsonStrings }),
    (text) => text.includes("[ref="),
  );

  assert(
    Option.exists(lastPage, (page) => holdsQuery.test(page)),
    `the fresh page the model got back after type holds "${query}"`,
  );

  const rows = auditRows();
  const allowed = rows.filter((row) => row.decision === "allow");
  assert(
    allowed.map((row) => row.action).join(",") === "navigate,click,type",
    `the audit table has navigate, click and type allow rows (${JSON.stringify(rows)})`,
  );
  assert(
    rows.filter((row) => row.decision === "succeeded").length === 3,
    "all three calls are recorded as succeeded",
  );

  const [click, type] = allowed
    .slice(1)
    .map((row) => Schema.decodeUnknownSync(RefDetail)(row.detail));

  assert(
    click?.role === "searchbox" && click.name === "Search Wikipedia",
    `click · allow names the element it clicked (${JSON.stringify(click)})`,
  );
  assert(
    type?.ref === click.ref && type.text === `[${query.length} chars]`,
    `type · allow names the same element and keeps only the text's length (${JSON.stringify(type)})`,
  );
  assert(!JSON.stringify(rows).includes(query), "no audit row holds the typed text");

  const traceIds = new Set(allowed.map((row) => row.trace_id ?? ""));
  const [traceId = ""] = traceIds;
  assert(
    traceIds.size === 1 && traceId !== "",
    `the allow rows carry the turn's trace_id (${[...traceIds].join(", ")})`,
  );

  let spans: Awaited<ReturnType<typeof traceSpans>> = [];

  await waitFor("the turn's three Gateway.act spans in Tempo", 60_000, async () => {
    spans = await traceSpans(grafanaUrl, traceId).catch(() => []);

    return spans.filter((span) => span.name === "Gateway.act").length === 3;
  });

  const gatewayCalls = spans
    .filter((span) => span.name === "Gateway.act")
    .map((span) => ancestry(spans, span));

  assert(
    gatewayCalls.every((path) => path[0] === "Chat.turn"),
    `one Gateway.act per action, each inside Chat.turn (${gatewayCalls.map((path) => path.join(" > ")).join("; ")})`,
  );

  assert(answers()[0] === `The search box holds ${query}.`, "the Bot said what it did");
}
