import { BrowserSocket } from "@effect/platform-browser";
import { ChatRpcs } from "@aobot/domain";
import { Layer } from "effect";
import { AtomRpc } from "effect/reactivity";
import { RpcClient, RpcSerialization } from "effect/rpc";

function socketUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";

  return `${scheme}://${window.location.host}/rpc`;
}

/** The chat API over one WebSocket to the same origin, JSON on the wire. It connects when first used. */
export class ChatClient extends AtomRpc.Service<ChatClient>()("ChatClient", {
  group: ChatRpcs,
  protocol: () =>
    RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
      Layer.provide(BrowserSocket.layerWebSocket(socketUrl())),
      Layer.provide(RpcSerialization.layerJson),
    ),
}) {}
