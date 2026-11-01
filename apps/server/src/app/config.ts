import { fileURLToPath } from "node:url";
import { Config, ConfigProvider, Duration, Option } from "effect";
import { agentRuntimeConfig } from "../features/agent/public.ts";
import { computerConfig } from "../features/computers/public.ts";
import { privateHostsProblem, sharedSubscriptionProblem } from "./local-only.ts";

const builtWebApp = fileURLToPath(new URL("../../../web/dist", import.meta.url));

const settings = Config.all({
  deployment: Config.Literals(["development", "production"], "AOBOT_ENV").pipe(
    Config.withDefault("development"),
  ),
  port: Config.Port("PORT").pipe(Config.withDefault(3000)),
  // Every address by default, so the server is reachable from outside its container.
  host: Config.String("HOST").pipe(Config.withDefault("0.0.0.0")),
  // The name people open the web app at when it is not this machine, such as `aobot.example.com`. Unset,
  // only a page on `localhost`, `127.0.0.1` or `[::1]` may use the RPC socket.
  publicHost: Config.option(Config.String("PUBLIC_HOST")),
  singleUser: Config.Boolean("SINGLE_USER").pipe(Config.withDefault(false)),
  webDistDir: Config.String("WEB_DIST_DIR").pipe(Config.withDefault(builtWebApp)),
  databasePath: Config.String("DATABASE_PATH").pipe(Config.withDefault("data/aobot.db")),
  // Unset means no telemetry export, so the server runs without a collector.
  otlpEndpoint: Config.option(Config.String("OTEL_EXPORTER_OTLP_ENDPOINT")),
  runtime: agentRuntimeConfig,
  computers: computerConfig,
  limits: Config.all({
    maxSteps: Config.Int("AGENT_MAX_STEPS").pipe(Config.withDefault(8)),
    stallTimeout: Config.Int("AGENT_STALL_TIMEOUT_MS").pipe(
      Config.withDefault(60_000),
      Config.map(Duration.millis),
    ),
  }),
});

/** Every setting the server reads, from the environment through Effect `Config`. */
export const serverConfig = settings.pipe(
  Config.flatMap((config) =>
    Option.match(
      Option.orElse(sharedSubscriptionProblem(config.runtime, config.singleUser, config.host), () =>
        privateHostsProblem(config.deployment, config.computers.allowPrivateHosts),
      ),
      {
        onNone: () => Config.succeed(config),
        onSome: (message) => Config.fail(new ConfigProvider.SourceError({ message })),
      },
    ),
  ),
);
