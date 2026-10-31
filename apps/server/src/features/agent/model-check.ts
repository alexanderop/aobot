import { Effect, type LogLevel } from "effect";
import { modelProviders, type ModelSettings } from "./model-providers.ts";

/** What the provider's answer means for whoever runs the server, and how loudly to say it. */
export interface ModelCheckFinding {
  readonly level: LogLevel.Severity;
  readonly message: string;
}

/** Read the provider's HTTP status for the model lookup as advice for the operator. */
export function modelCheckFinding(settings: ModelSettings, status: number): ModelCheckFinding {
  const { provider, name } = settings;

  if (status >= 200 && status < 300) {
    return { level: "Info", message: `${provider} model ${name} is available to MODEL_API_KEY.` };
  }

  if (status === 401 || status === 403) {
    return {
      level: "Warn",
      message: `${provider} refused MODEL_API_KEY (HTTP ${status}), so every Bot turn will fail. Set MODEL_API_KEY to a valid key for ${provider}.`,
    };
  }

  if (status === 404 && provider === "openai-compat") {
    return {
      level: "Info",
      message: `The server at MODEL_BASE_URL has no model lookup for ${name} (HTTP 404). Many OpenAI-compatible servers do not offer one, so this says nothing about whether turns will work.`,
    };
  }

  if (status === 404) {
    return {
      level: "Warn",
      message: `MODEL_API_KEY cannot use ${provider} model ${name} (HTTP 404), so every Bot turn will fail. Check the spelling of MODEL_NAME, give the key access to ${name}, or pick a model the key has.`,
    };
  }

  return {
    level: "Warn",
    message: `${provider} did not say whether ${name} is available (HTTP ${status}). This is often temporary.`,
  };
}

/**
Ask the provider once whether the key can use the configured model, and log what to do about it.
Never fails: a broken key should show up in the log at boot, not stop the server.
*/
export const checkModel = Effect.fn("Agent.checkModel")(function* (settings: ModelSettings) {
  const finding = yield* modelProviders[settings.provider].lookupModel(settings).pipe(
    Effect.timeout("10 seconds"),
    Effect.map((response) => modelCheckFinding(settings, response.status)),
    Effect.catch((error): Effect.Effect<ModelCheckFinding> =>
      Effect.succeed({
        level: "Warn",
        message: `Could not ask ${settings.provider} whether ${settings.name} is available: ${error.message}. Check MODEL_BASE_URL and the network.`,
      }),
    ),
  );

  yield* Effect.logWithLevel(finding.level)(finding.message);
});
