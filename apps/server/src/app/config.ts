import { fileURLToPath } from "node:url";
import { Config, Duration } from "effect";
import { modelConfig } from "../features/agent/public.ts";

const builtWebApp = fileURLToPath(new URL("../../../web/dist", import.meta.url));

/** Every setting the server reads, from the environment through Effect `Config`. */
export const serverConfig = Config.all({
  port: Config.Port("PORT").pipe(Config.withDefault(3000)),
  webDistDir: Config.String("WEB_DIST_DIR").pipe(Config.withDefault(builtWebApp)),
  databasePath: Config.String("DATABASE_PATH").pipe(Config.withDefault("data/aobot.db")),
  // Unset means no telemetry export, so the server runs without a collector.
  otlpEndpoint: Config.option(Config.String("OTEL_EXPORTER_OTLP_ENDPOINT")),
  model: modelConfig,
  limits: Config.all({
    maxSteps: Config.Int("AGENT_MAX_STEPS").pipe(Config.withDefault(8)),
    stallTimeout: Config.Int("AGENT_STALL_TIMEOUT_MS").pipe(
      Config.withDefault(60_000),
      Config.map(Duration.millis),
    ),
  }),
});
