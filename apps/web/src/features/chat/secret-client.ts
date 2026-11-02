import { SecretRpcs } from "@aobot/domain";
import { AtomRpc } from "effect/reactivity";
import { rpcProtocol } from "../../shared/rpc-protocol.ts";

/** The secret API on a WebSocket of its own: a person answering the secret a Bot asked for. */
export class SecretClient extends AtomRpc.Service<SecretClient>()("SecretClient", {
  group: SecretRpcs,
  protocol: rpcProtocol,
}) {}
