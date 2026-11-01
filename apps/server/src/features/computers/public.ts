import type { Option } from "effect";
import { dockerComputers } from "./docker.ts";
import { ComputerProvider, type ComputerSettings } from "./settings.ts";

export {
  type Computer,
  ComputerActFailed,
  ComputerLost,
  Computers,
  ComputerUnavailable,
} from "./computers.ts";

export { computerConfig, ComputerProvider, type ComputerSettings } from "./settings.ts";

/** {@link Computers} from the provider `settings` names. */
export function computersLayer(
  settings: ComputerSettings,
  telemetry: { readonly otlpEndpoint: Option.Option<string> },
) {
  return ComputerProvider.$match(settings.provider, {
    Docker: (docker) =>
      dockerComputers({
        docker,
        allowPrivateHosts: settings.allowPrivateHosts,
        otlpEndpoint: telemetry.otlpEndpoint,
      }),
  });
}
