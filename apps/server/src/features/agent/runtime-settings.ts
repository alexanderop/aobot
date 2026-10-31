import { Config, Data } from "effect";
import { type AcpAgentName, AcpAgentName as AcpAgentNameSchema } from "./acp/launchers.ts";
import { modelConfig, type ModelSettings } from "./model-providers.ts";

/** Which think-act loop runs a Bot's turns, with the settings only that loop reads. */
export type AgentRuntimeSettings = Data.TaggedEnum<{
  /** Our own loop over an API key's model. */
  Api: { readonly model: ModelSettings };
  /** The person's own CLI over ACP, on their subscription. `home` is where its sign-in lives. */
  Acp: { readonly agent: AcpAgentName; readonly home: string };
}>;

/** Constructors and matchers for {@link AgentRuntimeSettings}. */
export const AgentRuntimeSettings = Data.taggedEnum<AgentRuntimeSettings>();

const RuntimeKind = ["api", "acp"] as const;

const runtimes = {
  api: Config.map(modelConfig, (model) => AgentRuntimeSettings.Api({ model })),
  acp: Config.map(
    Config.all({
      agent: Config.schema(AcpAgentNameSchema, "ACP_AGENT"),
      home: Config.String("HOME"),
    }),
    (acp) => AgentRuntimeSettings.Acp(acp),
  ),
} satisfies {
  readonly [Kind in (typeof RuntimeKind)[number]]: Config.Config<AgentRuntimeSettings>;
};

/**
`AGENT_RUNTIME` (`api` by default) and the settings of the runtime it names: `MODEL_*` for `api`,
`ACP_AGENT` for `acp`. A runtime never asks for the other's settings.
*/
export const agentRuntimeConfig = Config.Literals(RuntimeKind, "AGENT_RUNTIME").pipe(
  Config.withDefault("api"),
  Config.flatMap((kind): Config.Config<AgentRuntimeSettings> => runtimes[kind]),
);
