import { Config, Data, type Option } from "effect";

/**
Containers on this machine's Docker Engine, through its socket. With `network`, the computer joins that
network and publishes nothing; without it, its port is published on loopback for a server on the host.
*/
export interface DockerSettings {
  readonly socketPath: string;
  readonly image: string;
  /** The shared computer's container name, so two stacks on one Docker Engine do not take each other's. */
  readonly name: string;
  readonly network: Option.Option<string>;
}

/** Where computers run, with the settings only that provider reads. ECS and Kubernetes arrive later. */
export type ComputerProvider = Data.TaggedEnum<{ Docker: DockerSettings }>;

/** Constructors and matchers for {@link ComputerProvider}. */
export const ComputerProvider = Data.taggedEnum<ComputerProvider>();

/** How computers are run, whatever the provider. */
export interface ComputerSettings {
  readonly provider: ComputerProvider;
  /** Lets the browser open private and loopback addresses, for local fixtures. Never in production. */
  readonly allowPrivateHosts: boolean;
}

const ProviderKind = ["docker"] as const;

const providers = {
  docker: Config.map(
    Config.all({
      socketPath: Config.String("DOCKER_SOCKET").pipe(Config.withDefault("/var/run/docker.sock")),
      image: Config.String("COMPUTER_IMAGE").pipe(Config.withDefault("aobot-computer:dev")),
      name: Config.String("COMPUTER_NAME").pipe(Config.withDefault("aobot-computer")),
      network: Config.option(Config.String("COMPUTER_NETWORK")),
    }),
    (docker) => ComputerProvider.Docker(docker),
  ),
} satisfies {
  readonly [Kind in (typeof ProviderKind)[number]]: Config.Config<ComputerProvider>;
};

/**
`COMPUTER_PROVIDER` (`docker` by default) and the settings of the provider it names, plus
`COMPUTER_ALLOW_PRIVATE_HOSTS` (false by default).
*/
export const computerConfig: Config.Config<ComputerSettings> = Config.all({
  provider: Config.Literals(ProviderKind, "COMPUTER_PROVIDER").pipe(
    Config.withDefault("docker"),
    Config.flatMap((kind): Config.Config<ComputerProvider> => providers[kind]),
  ),
  allowPrivateHosts: Config.Boolean("COMPUTER_ALLOW_PRIVATE_HOSTS").pipe(Config.withDefault(false)),
});
