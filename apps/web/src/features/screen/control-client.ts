import { ControlRpcs } from "@aobot/domain";
import { AtomRpc } from "effect/reactivity";
import { rpcProtocol } from "../../shared/rpc-protocol.ts";

/** The control API on a WebSocket of its own, so a person's click never waits behind a screen frame. */
export class ControlClient extends AtomRpc.Service<ControlClient>()("ControlClient", {
  group: ControlRpcs,
  protocol: rpcProtocol,
}) {}
