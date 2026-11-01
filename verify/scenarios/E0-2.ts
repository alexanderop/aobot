import { assert, browser, waitFor } from "../browser.ts";
import { ancestry, tempo, traceSpans } from "../tempo.ts";

interface TempoSearch {
  readonly traces?: ReadonlyArray<{
    readonly traceID: string;
    readonly rootTraceName?: string;
    readonly startTimeUnixNano: string;
  }>;
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

  const spans = await traceSpans(grafanaUrl, traceId);

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
