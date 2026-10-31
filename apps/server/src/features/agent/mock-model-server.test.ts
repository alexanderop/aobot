import { MessageId } from "@aobot/domain";
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Layer, Option, Redacted, Ref, Schema, Stream } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { FetchHttpClient } from "effect/http";
import { AgentEvent, AgentRuntime, type Turn } from "./agent-runtime.ts";
import { layerApi } from "./api-runtime.ts";
import { languageModelLayer, ModelProvider } from "./model-providers.ts";
import { mockModel } from "./testing/mock-model-server.ts";
import { ModelStep } from "./testing/model-script.ts";

const Forecast = Tool.make("forecast", {
  description: "Says the weather in a city",
  parameters: Schema.Struct({ city: Schema.String, days: Schema.Number }),
  success: Schema.String,
});

const ForecastToolkit = Toolkit.make(Forecast);

const script = [
  ModelStep.CallTools({ calls: [{ name: "forecast", params: { city: "Vienna", days: 3 } }] }),
  ModelStep.Say({ words: ["Sunny", " in", " Vienna"] }),
];

const turn: Turn = {
  instructions: "Answer briefly.",
  history: [{ id: MessageId.make("message-1"), role: "user", text: "Weather in Vienna?" }],
};

describe("the mock model server", () => {
  it.live.each(ModelProvider.literals)(
    "replays a tool call and an answer to the %s provider",
    (provider) =>
      Effect.gen(function* () {
        const baseUrls = yield* mockModel(script);
        const asked = yield* Ref.make<ReadonlyArray<typeof Forecast.parametersSchema.Type>>([]);

        const handlers = ForecastToolkit.toLayer({
          forecast: (input) =>
            Ref.update(asked, (inputs) => [...inputs, input]).pipe(Effect.as("sunny")),
        });

        const model = languageModelLayer({
          provider,
          name: "mock",
          apiKey: Redacted.make("mock"),
          baseUrl: Option.some(baseUrls[provider]),
        });

        const runtime = layerApi(ForecastToolkit, {
          maxSteps: 4,
          stallTimeout: Duration.seconds(10),
        }).pipe(Layer.provide([model, handlers]), Layer.provide(FetchHttpClient.layer));

        const events = yield* Effect.gen(function* () {
          const agent = yield* AgentRuntime;

          return yield* Stream.runCollect(agent.run(turn));
        }).pipe(Effect.provide(runtime));

        const text = events.flatMap((event) =>
          AgentEvent.$is("TextDelta")(event) ? [event.text] : [],
        );

        expect(yield* Ref.get(asked)).toEqual([{ city: "Vienna", days: 3 }]);
        expect(text.join("")).toBe("Sunny in Vienna");
        expect(events.at(-1)).toEqual(AgentEvent.Done());
      }),
  );
});
