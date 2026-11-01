import { ChatRpcs } from "@aobot/domain";
import { AtomRpc } from "effect/reactivity";
import { rpcProtocol } from "../../shared/rpc-protocol.ts";

/** The chat API over one WebSocket to the same origin. It connects when first used. */
export class ChatClient extends AtomRpc.Service<ChatClient>()("ChatClient", {
  group: ChatRpcs,
  protocol: rpcProtocol,
}) {}
