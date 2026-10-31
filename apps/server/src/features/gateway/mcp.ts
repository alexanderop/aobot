import { McpProtocol, McpServer } from "effect/ai";
import { botToolkit } from "../bots/public.ts";

/**
The gateway's tools as one Streamable HTTP MCP server at `/mcp`, for `acp` CLIs to call. The toolkit is
empty until E1-1, so a CLI connects and lists nothing.
*/
export const gatewayMcpLayer = McpServer.layerHttp({
  name: "aobot-gateway",
  version: "0.1.0",
  path: "/mcp",
  protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26],
  registrations: McpServer.toolkit(botToolkit),
});

/** The name the gateway's MCP server is offered under in `session/new`. */
export const gatewayMcpName = "aobot";
