import { canonicalHost } from "@aobot/domain";
import { Option } from "effect";
import { AgentRuntimeSettings } from "../features/agent/public.ts";
import { AuthSettings } from "../features/auth/public.ts";
import { onThisMachine } from "../shared/reach.ts";

/**
Why the server must not start, if it must not. `acp` runs on one person's own subscription, so it only
runs in single-user mode and only where nobody else can reach it.
*/
export function sharedSubscriptionProblem(
  runtime: AgentRuntimeSettings,
  auth: AuthSettings,
  host: string,
): Option.Option<string> {
  if (!AgentRuntimeSettings.$is("Acp")(runtime)) return Option.none();

  if (!AuthSettings.$is("SingleUser")(auth)) {
    return Option.some(
      "AGENT_RUNTIME=acp runs Bots on one person's own subscription, so it needs SINGLE_USER=true.",
    );
  }

  if (!onThisMachine(canonicalHost(host))) {
    return Option.some(
      `AGENT_RUNTIME=acp must only be reachable from this machine, but HOST is ${host}. Set HOST=127.0.0.1.`,
    );
  }

  return Option.none();
}

/** Where this server runs. `production` is anything other people rely on. */
export type Deployment = "development" | "production";

/**
Why the server must not start, if it must not. Private hosts are for local fixtures; in production they
would let a Bot browse to internal services and the metadata address.
*/
export function privateHostsProblem(
  deployment: Deployment,
  allowPrivateHosts: boolean,
): Option.Option<string> {
  return deployment === "production" && allowPrivateHosts
    ? Option.some(
        "COMPUTER_ALLOW_PRIVATE_HOSTS=true lets a Bot browse to private and metadata addresses, so it is refused with AOBOT_ENV=production.",
      )
    : Option.none();
}
