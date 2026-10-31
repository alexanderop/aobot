import { MessageId } from "@aobot/domain";
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Layer, Stream } from "effect";
import { Toolkit } from "effect/ai";
import { FetchHttpClient } from "effect/http";
import { AgentEvent, AgentRuntime } from "./agent-runtime.ts";
import { layerApi } from "./api-runtime.ts";
import { languageModelLayer, modelConfig } from "./model-providers.ts";

const realModel = Layer.unwrap(
  Effect.gen(function* () {
    return languageModelLayer(yield* modelConfig);
  }),
);

describe("the configured real model", () => {
  it.live(
    "answers a turn with text",
    () =>
      Effect.gen(function* () {
        const agent = yield* AgentRuntime;

        const events = yield* Stream.runCollect(
          agent.run({
            instructions: "Answer in one short sentence.",
            history: [{ id: MessageId.make("smoke-1"), role: "user", text: "Say hello." }],
          }),
        );

        const text = events.flatMap((event) =>
          AgentEvent.$is("TextDelta")(event) ? [event.text] : [],
        );

        expect(text.join("").trim()).not.toBe("");
        expect(events.at(-1)).toEqual(AgentEvent.Done());
      }).pipe(
        Effect.provide(
          layerApi(Toolkit.empty, { maxSteps: 2, stallTimeout: Duration.seconds(60) }).pipe(
            Layer.provide(realModel),
            Layer.provide(FetchHttpClient.layer),
          ),
        ),
      ),
    90_000,
  );
});
