import { ApprovalRpcs } from "@aobot/domain";
import { AtomRpc } from "effect/reactivity";
import { rpcProtocol } from "../../shared/rpc-protocol.ts";

/** The approval API on a WebSocket of its own: a person answering an action a rule asked them about. */
export class ApprovalClient extends AtomRpc.Service<ApprovalClient>()("ApprovalClient", {
  group: ApprovalRpcs,
  protocol: rpcProtocol,
}) {}
