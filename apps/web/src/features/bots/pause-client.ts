import { PauseRpcs } from "@aobot/domain";
import { AtomRpc } from "effect/reactivity";
import { rpcProtocol } from "../../shared/rpc-protocol.ts";

/** The pause API on a WebSocket of its own. It connects when first used. */
export class PauseClient extends AtomRpc.Service<PauseClient>()("PauseClient", {
  group: PauseRpcs,
  protocol: rpcProtocol,
}) {}
