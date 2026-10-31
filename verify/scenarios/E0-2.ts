import { assert, browser, waitFor } from "../browser.ts";

/** One span as Tempo returns it from `/api/v2/traces/<id>` (OTLP JSON, ids in base64). */
interface TempoSpan {
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
}

interface TempoTrace {
  readonly trace: {
    readonly resourceSpans: ReadonlyArray<{
      readonly scopeSpans: ReadonlyArray<{ readonly spans: ReadonlyArray<TempoSpan> }>;
    }>;
  };
}

interface TempoSearch {
  readonly traces?: ReadonlyArray<{
    readonly traceID: string;
    readonly rootTraceName?: string;
    readonly startTimeUnixNano: string;
  }>;
}

async function tempo<A>(grafanaUrl: string, path: string): Promise<A> {
  const response = await fetch(`${grafanaUrl}/api/datasources/proxy/uid/tempo${path}`);

  if (!response.ok) throw new Error(`Tempo answered ${response.status} for ${path}`);

  // SAFETY: the caller names the shape Tempo's API documents. A wrong guess fails the scenario's
  // assertions, which print what came back.
  return (await response.json()) as A;
}

/** The names from the root down to `span`. */
function ancestry(spans: ReadonlyArray<TempoSpan>, span: TempoSpan): ReadonlyArray<string> {
  const parent = spans.find((candidate) => candidate.spanId === span.parentSpanId);

  return parent === undefined ? [span.name] : [...ancestry(spans, parent), span.name];
}

/** E0-2: send a message, then find that turn in Tempo as one trace rooted at `Chat.turn`. */
export default async function scenario(baseUrl: string, grafanaUrl: string): Promise<void> {
  const sentAt = Math.floor(Date.now() / 1000);

  browser("open", baseUrl);
  browser("wait", "--load", "networkidle");
  browser("find", "placeholder", "Message Assistant", "fill", "Say hi in five words");
  browser("press", "Enter");

  await waitFor("the whole answer", 20_000, () =>
    browser("get", "text", "body").includes("Hi there, nice to meet you!"),
  );

  const query = new URLSearchParams({
    q: '{ resource.service.name = "aobot-server" }',
    start: String(sentAt - 60),
    end: String(sentAt + 600),
  });

  let traceId: string | undefined;

  await waitFor("a Chat.turn trace in Tempo", 60_000, async () => {
    const found = await tempo<TempoSearch>(grafanaUrl, `/api/search?${query.toString()}`);

    const newest = [...(found.traces ?? [])].sort((a, b) =>
      Number(BigInt(b.startTimeUnixNano) - BigInt(a.startTimeUnixNano)),
    )[0];

    traceId = newest?.rootTraceName === "Chat.turn" ? newest.traceID : undefined;

    return traceId !== undefined;
  });

  assert(traceId !== undefined, `the newest trace is named Chat.turn (${traceId})`);

  const { trace } = await tempo<TempoTrace>(grafanaUrl, `/api/v2/traces/${traceId}`);

  const spans = trace.resourceSpans.flatMap(({ scopeSpans }) =>
    scopeSpans.flatMap(({ spans }) => spans),
  );

  const roots = spans.filter((span) => span.parentSpanId === undefined);
  assert(
    roots.length === 1 && roots[0]?.name === "Chat.turn",
    `the trace has one root, Chat.turn (roots: ${roots.map((span) => span.name).join(", ")})`,
  );

  const modelCalls = spans
    .filter((span) => span.name === "LanguageModel.streamText")
    .map((span) => ancestry(spans, span));

  assert(
    modelCalls.length === 1 &&
      modelCalls[0]?.[0] === "Chat.turn" &&
      modelCalls[0].includes("AgentRuntime.run"),
    `the model call sits inside the agent run inside Chat.turn (${modelCalls.map((path) => path.join(" > ")).join("; ")})`,
  );
}
