import { BotRpcs } from "@aobot/domain";
import { AtomRpc } from "effect/reactivity";
import { rpcProtocol } from "../../shared/rpc-protocol.ts";

/** The Bots API on a WebSocket of its own. It connects when first used. */
export class BotClient extends AtomRpc.Service<BotClient>()("BotClient", {
  group: BotRpcs,
  protocol: rpcProtocol,
}) {}
