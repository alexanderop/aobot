import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import {
  OpenAiClient as OpenAiCompatClient,
  OpenAiLanguageModel as OpenAiCompatLanguageModel,
} from "@effect/ai-openai-compat";
import { Config, Effect, Layer, Option, type Redacted, Schema } from "effect";
import type { LanguageModel } from "effect/ai";
import type { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

/** Which API the `api` runtime talks to. `openai-compat` is any server that speaks Chat Completions. */
export const ModelProvider = Schema.Literals(["anthropic", "openai", "openai-compat"]);

/** A decoded {@link ModelProvider}. */
export type ModelProvider = typeof ModelProvider.Type;

/** The model a deployment's Bots run on and the key that pays for it. */
export interface ModelSettings {
  readonly provider: ModelProvider;
  readonly name: string;
  readonly apiKey: Redacted.Redacted<string>;
  readonly baseUrl: Option.Option<string>;
}

/** The model settings, from `MODEL_PROVIDER`, `MODEL_NAME`, `MODEL_API_KEY` and `MODEL_BASE_URL`. */
export const modelConfig = Config.all({
  provider: Config.schema(ModelProvider, "MODEL_PROVIDER"),
  name: Config.String("MODEL_NAME"),
  apiKey: Config.Redacted("MODEL_API_KEY"),
  baseUrl: Config.option(Config.String("MODEL_BASE_URL")),
});

/** What the app needs from one provider: the model itself, and a lookup of the model by name. */
interface ProviderEntry {
  readonly languageModel: (
    settings: ModelSettings,
  ) => Layer.Layer<LanguageModel.LanguageModel, never, HttpClient.HttpClient>;
  /** Ask the provider about the configured model, with the same key and base URL the model uses. */
  readonly lookupModel: (
    settings: ModelSettings,
  ) => Effect.Effect<
    HttpClientResponse.HttpClientResponse,
    HttpClientError.HttpClientError,
    HttpClient.HttpClient
  >;
}

function clientOptions(settings: ModelSettings) {
  return { apiKey: settings.apiKey, apiUrl: Option.getOrUndefined(settings.baseUrl) };
}

const modelPath = (settings: ModelSettings) => `/models/${encodeURIComponent(settings.name)}`;

/** One entry per provider, so adding one is a row here rather than a branch everywhere. */
export const modelProviders = {
  anthropic: {
    languageModel: (settings) =>
      AnthropicLanguageModel.layer({ model: settings.name }).pipe(
        Layer.provide(AnthropicClient.layer(clientOptions(settings))),
      ),
    lookupModel: (settings) =>
      Effect.flatMap(AnthropicClient.make(clientOptions(settings)), (client) =>
        client.client.httpClient.get(`/v1${modelPath(settings)}`),
      ),
  },
  openai: {
    languageModel: (settings) =>
      OpenAiLanguageModel.layer({ model: settings.name }).pipe(
        Layer.provide(OpenAiClient.layer(clientOptions(settings))),
      ),
    lookupModel: (settings) =>
      Effect.flatMap(OpenAiClient.make(clientOptions(settings)), (client) =>
        client.client.get(modelPath(settings)),
      ),
  },
  "openai-compat": {
    languageModel: (settings) =>
      OpenAiCompatLanguageModel.layer({ model: settings.name }).pipe(
        Layer.provide(OpenAiCompatClient.layer(clientOptions(settings))),
      ),
    lookupModel: (settings) =>
      Effect.flatMap(OpenAiCompatClient.make(clientOptions(settings)), (client) =>
        client.client.get(modelPath(settings)),
      ),
  },
} satisfies { readonly [P in ModelProvider]: ProviderEntry };

/** The configured model as a `LanguageModel` layer. */
export function languageModelLayer(settings: ModelSettings) {
  return modelProviders[settings.provider].languageModel(settings);
}
