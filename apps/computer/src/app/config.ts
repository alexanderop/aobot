import { Config, Schema } from "effect";
import { inheritedEnvironment } from "../features/shell/public.ts";

/** Every setting the computer reads, from the environment through Effect `Config`. */
export const computerConfig = Config.all({
  port: Config.Port("PORT").pipe(Config.withDefault(4100)),
  token: Config.schema(Schema.Redacted(Schema.NonEmptyString), "COMPUTER_TOKEN"),
  // On only for local fixtures. Metadata addresses stay refused either way.
  allowPrivateHosts: Config.Boolean("COMPUTER_ALLOW_PRIVATE_HOSTS").pipe(Config.withDefault(false)),
  // Unset means no telemetry export, so the computer runs without a collector.
  otlpEndpoint: Config.option(Config.String("OTEL_EXPORTER_OTLP_ENDPOINT")),
  home: Config.String("HOME"),
  shell: inheritedEnvironment,
});
