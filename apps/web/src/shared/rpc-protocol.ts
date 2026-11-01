import { BrowserSocket } from "@effect/platform-browser";
import { Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";

/** The server's RPC socket on the page's own origin, JSON on the wire. Each client opens its own. */
export function rpcProtocol() {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";

  return RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
    Layer.provide(BrowserSocket.layerWebSocket(`${scheme}://${window.location.host}/rpc`)),
    Layer.provide(RpcSerialization.layerJson),
  );
}
