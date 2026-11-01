import { ScreenRpcs } from "@aobot/domain";
import { AtomRpc } from "effect/reactivity";
import { rpcProtocol } from "../../shared/rpc-protocol.ts";

/** The screen API on a WebSocket of its own, so a stream of large frames never holds up a chat event. */
export class ScreenClient extends AtomRpc.Service<ScreenClient>()("ScreenClient", {
  group: ScreenRpcs,
  protocol: rpcProtocol,
}) {}
