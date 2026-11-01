import { fileURLToPath } from "node:url";
import { Config, ConfigProvider, Duration, Option } from "effect";
import { agentRuntimeConfig } from "../features/agent/public.ts";
import { sharedSubscriptionProblem } from "./local-only.ts";

const builtWebApp = fileURLToPath(new URL("../../../web/dist", import.meta.url));

const settings = Config.all({
  port: Config.Port("PORT").pipe(Config.withDefault(3000)),
  // Every address by default, so the server is reachable from outside its container.
  host: Config.String("HOST").pipe(Config.withDefault("0.0.0.0")),
  singleUser: Config.Boolean("SINGLE_USER").pipe(Config.withDefault(false)),
  webDistDir: Config.String("WEB_DIST_DIR").pipe(Config.withDefault(builtWebApp)),
  databasePath: Config.String("DATABASE_PATH").pipe(Config.withDefault("data/aobot.db")),
  // Unset means no telemetry export, so the server runs without a collector.
  otlpEndpoint: Config.option(Config.String("OTEL_EXPORTER_OTLP_ENDPOINT")),
  runtime: agentRuntimeConfig,
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
    Option.match(sharedSubscriptionProblem(config.runtime, config.singleUser, config.host), {
      onNone: () => Config.succeed(config),
      onSome: (message) => Config.fail(new ConfigProvider.SourceError({ message })),
    }),
  ),
);
