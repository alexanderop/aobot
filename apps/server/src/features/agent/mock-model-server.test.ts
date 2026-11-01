import { MessageId, ToolCallId } from "@aobot/domain";
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Layer, Option, Redacted, Ref, Schema, Stream } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { FetchHttpClient } from "effect/http";
import { AgentEvent, AgentRuntime, type Turn } from "./agent-runtime.ts";
import { layerApi } from "./api-runtime.ts";
import { languageModelLayer, ModelProvider } from "./model-providers.ts";
import { mockModel, startMockModel } from "./testing/mock-model-server.ts";
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

  describe("given a script sent to PUT /mock/script", () => {
    const greeting = [ModelStep.Say({ words: ["Hi", " there"] })];

    const running = Effect.acquireRelease(
      Effect.promise(() =>
        startMockModel({
          script: greeting,
          afterLastStep: "fail",
          delayMs: 0,
          host: "127.0.0.1",
          port: 0,
        }),
      ),
      (server) => Effect.promise(() => server.close()),
    ).pipe(Effect.map((server) => `http://127.0.0.1:${server.port}`));

    const putScript = (origin: string, body: string) =>
      Effect.promise(() => fetch(`${origin}/mock/script`, { method: "PUT", body }));

    const askWith = (origin: string) =>
      Effect.gen(function* () {
        const agent = yield* AgentRuntime;

        return yield* Stream.runCollect(agent.run(turn));
      }).pipe(
        Effect.provide(
          layerApi(ForecastToolkit, { maxSteps: 4, stallTimeout: Duration.seconds(10) }).pipe(
            Layer.provide([
              languageModelLayer({
                provider: "openai-compat",
                name: "mock",
                apiKey: Redacted.make("mock"),
                baseUrl: Option.some(`${origin}/v1`),
              }),
              ForecastToolkit.toLayer({ forecast: () => Effect.succeed("sunny") }),
            ]),
            Layer.provide(FetchHttpClient.layer),
          ),
        ),
      );

    it.live("answers with the new script from its first step, each time it is sent", () =>
      Effect.gen(function* () {
        const origin = yield* running;

        for (const attempt of [1, 2]) {
          const answer = yield* putScript(origin, JSON.stringify(script));
          expect(answer.status, `PUT number ${attempt}`).toBe(200);

          const events = yield* askWith(origin);

          expect(events.filter(AgentEvent.$is("ToolCallStarted"))).toEqual([
            AgentEvent.ToolCallStarted({
              id: ToolCallId.make("call_1_0"),
              name: "forecast",
              params: { city: "Vienna", days: 3 },
            }),
          ]);
          expect(events.at(-1)).toEqual(AgentEvent.Done());
        }
      }),
    );

    it.live("answers GET /mock/requests with what the model was sent since the script", () =>
      Effect.gen(function* () {
        const origin = yield* running;
        yield* askWith(origin);

        yield* putScript(origin, JSON.stringify(greeting));
        yield* askWith(origin);

        const answer = yield* Effect.promise(() => fetch(`${origin}/mock/requests`));

        const { requests } = Schema.decodeUnknownSync(
          Schema.Struct({ requests: Schema.Array(Schema.String) }),
        )(yield* Effect.promise(() => answer.json()));

        expect(answer.status).toBe(200);
        expect(requests).toHaveLength(1);
        expect(requests[0]).toContain("Weather in Vienna?");
      }),
    );

    it.live("refuses a body that is not a script and keeps the one it has", () =>
      Effect.gen(function* () {
        const origin = yield* running;

        const refused = yield* putScript(origin, '[{"_tag":"Shout","words":[]}]');
        expect(refused.status).toBe(400);

        const events = yield* askWith(origin);

        const text = events.flatMap((event) =>
          AgentEvent.$is("TextDelta")(event) ? [event.text] : [],
        );

        expect(text.join("")).toBe("Hi there");
      }),
    );
  });
});
