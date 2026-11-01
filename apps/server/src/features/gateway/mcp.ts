import { Effect, Layer, Option } from "effect";
import { McpProtocol, McpServer } from "effect/ai";
import { HttpTraceContext } from "effect/http";
import { botToolkit } from "../bots/public.ts";
import { botToolHandlers } from "./tools.ts";

/**
Runs each tool call inside the trace named by the request's `traceparent`. The `acp` runtime offers this
server with its turn's `traceparent` as a header, so a CLI's tool calls land inside `Chat.turn` too.
*/
const turnTrace = McpServer.middleware((effect, { headers }) =>
  Option.match(HttpTraceContext.fromHeaders(headers), {
    onNone: () => effect,
    onSome: (parent) => Effect.withParentSpan(effect, parent),
  }),
);

/** The gateway's tools as one Streamable HTTP MCP server at `/mcp`, for `acp` CLIs to call. */
export const gatewayMcpLayer = McpServer.layerHttp({
  name: "aobot-gateway",
  version: "0.1.0",
  path: "/mcp",
  protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26],
  registrations: McpServer.toolkit(botToolkit).pipe(
    Layer.provide(turnTrace.layer),
    Layer.provide(botToolHandlers),
  ),
});

/** The name the gateway's MCP server is offered under in `session/new`. */
export const gatewayMcpName = "aobot";
