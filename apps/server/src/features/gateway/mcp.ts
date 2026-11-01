import { BotId } from "@aobot/domain";
import { Effect, Layer, Option, Schema } from "effect";
import { McpProtocol, McpServer } from "effect/ai";
import { Headers, HttpTraceContext } from "effect/http";
import { botToolkit } from "../bots/public.ts";
import { Claim } from "./gateway.ts";
import { ActingBot, botToolHandlers } from "./tools.ts";

/** The header the `acp` runtime names its turn's Bot in, on every call its CLI makes to this server. */
export const botHeader = "aobot-bot";

const decodeBot = Schema.decodeUnknownOption(BotId);

/** The Bot the header names, or the header as written when it is no Bot id. */
function claimOf(header: Option.Option<string>): Claim {
  return Option.match(header, {
    onNone: () => Claim.cases.Unnamed.make({}),
    onSome: (written) =>
      Option.match(decodeBot(written), {
        onNone: () => Claim.cases.Unreadable.make({ header: written }),
        onSome: (bot) => Claim.cases.Named.make({ bot }),
      }),
  });
}

/**
Runs each tool call on behalf of the Bot the request's `aobot-bot` header names, inside the trace its
`traceparent` names. The `acp` runtime offers this server with both headers set to its turn's, so a CLI's
tool calls are its Bot's and land inside `Chat.turn` too. A call without a Bot the header names is refused
by the gateway as not granted.
*/
const turnContext = McpServer.middleware((effect, { headers }) =>
  Option.match(HttpTraceContext.fromHeaders(headers), {
    onNone: () => effect,
    onSome: (parent) => Effect.withParentSpan(effect, parent),
  }).pipe(Effect.provideService(ActingBot, claimOf(Headers.get(headers, botHeader)))),
);

/** The gateway's tools as one Streamable HTTP MCP server at `/mcp`, for `acp` CLIs to call. */
export const gatewayMcpLayer = McpServer.layerHttp({
  name: "aobot-gateway",
  version: "0.1.0",
  path: "/mcp",
  protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26],
  registrations: McpServer.toolkit(botToolkit).pipe(
    Layer.provide(turnContext.layer),
    Layer.provide(botToolHandlers),
  ),
});

/** The name the gateway's MCP server is offered under in `session/new`. */
export const gatewayMcpName = "aobot";
