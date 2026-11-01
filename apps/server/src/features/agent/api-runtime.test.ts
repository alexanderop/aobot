import { MessageId, ToolCallId } from "@aobot/domain";
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer, Queue, Ref, Schema, Stream } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { TestClock } from "effect/testing";
import { AgentEvent, AgentRuntime, Stalled, StepLimit, type Turn } from "./agent-runtime.ts";
import { layerApi } from "./api-runtime.ts";
import { ModelStep } from "./testing/model-script.ts";
import {
  replay,
  type ScriptedAnswer,
  scriptedModel,
  textParts,
  toolCallParts,
} from "./testing/scripted-model.ts";

const Ping = Tool.make("ping", {
  description: "Answers pong",
  parameters: Schema.Struct({}),
  success: Schema.String,
});

const PingToolkit = Toolkit.make(Ping);

const Forecast = Tool.make("forecast", {
  description: "Says the weather in a city",
  parameters: Schema.Struct({ city: Schema.String, days: Schema.Number }),
  success: Schema.String,
});

const ForecastToolkit = Toolkit.make(Forecast);

const pingHandlers = PingToolkit.toLayer({ ping: () => Effect.succeed("pong") });

const limits = { maxSteps: 8, stallTimeout: Duration.seconds(60) };

const turn: Turn = {
  instructions: "Answer briefly.",
  history: [{ id: MessageId.make("message-1"), role: "user", text: "Say hi" }],
};

function runtimeWith(answer: (call: number) => ScriptedAnswer) {
  return layerApi(PingToolkit, limits).pipe(Layer.provide([scriptedModel(answer), pingHandlers]));
}

/**
Move the test clock forward a second at a time. Real time never jumps, and one large `adjust` wakes the
watchdog before the scripted model has asked for its next sleep.
*/
function advanceSeconds(seconds: number) {
  return Effect.forEach(Array.from({ length: seconds }), () => TestClock.adjust("1 second"), {
    discard: true,
  });
}

const runTurn = Effect.gen(function* () {
  const agent = yield* AgentRuntime;

  return yield* agent.run(turn).pipe(Stream.runCollect);
});

describe("AgentRuntime (api)", () => {
  it.effect("streams the answer as text, then done, in order", () =>
    Effect.gen(function* () {
      const events = yield* runTurn;

      expect(events).toEqual([
        AgentEvent.TextDelta({ text: "Hi" }),
        AgentEvent.TextDelta({ text: " there" }),
        AgentEvent.Done(),
      ]);
    }).pipe(
      Effect.provide(runtimeWith(() => Stream.fromIterable(textParts(["Hi", "", " there"])))),
    ),
  );

  it.effect("stops a model that keeps calling tools at the step cap", () => {
    let calls = 0;

    return Effect.gen(function* () {
      const error = yield* Effect.flip(runTurn);

      expect(error).toEqual(new StepLimit({ steps: 8 }));
      expect(calls).toBe(8);
    }).pipe(
      Effect.provide(
        runtimeWith((call) => {
          calls = call;

          return Stream.fromIterable(toolCallParts([{ name: "ping", params: {} }], call));
        }),
      ),
    );
  });

  it.effect("answers after a few tool calls within the cap", () =>
    Effect.gen(function* () {
      const events = yield* runTurn;

      expect(events).toEqual([
        AgentEvent.ToolCallStarted({ id: ToolCallId.make("call-1-0"), name: "ping", params: {} }),
        AgentEvent.ToolCallFinished({
          id: ToolCallId.make("call-1-0"),
          result: "pong",
          failed: false,
        }),
        AgentEvent.ToolCallStarted({ id: ToolCallId.make("call-2-0"), name: "ping", params: {} }),
        AgentEvent.ToolCallFinished({
          id: ToolCallId.make("call-2-0"),
          result: "pong",
          failed: false,
        }),
        AgentEvent.TextDelta({ text: "pong" }),
        AgentEvent.Done(),
      ]);
    }).pipe(
      Effect.provide(
        runtimeWith((call) =>
          Stream.fromIterable(
            call < 3 ? toolCallParts([{ name: "ping", params: {} }], call) : textParts(["pong"]),
          ),
        ),
      ),
    ),
  );

  it.effect("cancels a model that goes silent once the stall limit passes", () =>
    Effect.gen(function* () {
      const agent = yield* AgentRuntime;
      const seen = yield* Queue.unbounded<AgentEvent>();

      const fiber = yield* agent.run(turn).pipe(
        Stream.runForEach((event) => Queue.offer(seen, event)),
        Effect.forkChild,
      );

      expect(yield* Queue.take(seen)).toEqual(AgentEvent.TextDelta({ text: "Hi" }));

      yield* advanceSeconds(59);
      expect(fiber.pollUnsafe()).toBeUndefined();

      yield* advanceSeconds(1);
      const error = yield* Effect.flip(Fiber.join(fiber));

      expect(error).toEqual(new Stalled({ waitedMs: 60_000 }));
    }).pipe(
      Effect.provide(
        runtimeWith(() =>
          Stream.concat(Stream.fromIterable(textParts(["Hi"]).slice(0, 2)), Stream.never),
        ),
      ),
    ),
  );

  it.effect("does not blame the model for a reader slower than the stall limit", () =>
    Effect.gen(function* () {
      const agent = yield* AgentRuntime;

      const fiber = yield* agent.run(turn).pipe(
        Stream.tap(() => Effect.sleep("90 seconds")),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* advanceSeconds(30 * 60);
      const events = yield* Fiber.join(fiber);

      expect(events).toEqual([
        AgentEvent.TextDelta({ text: "Hi" }),
        AgentEvent.TextDelta({ text: " there" }),
        AgentEvent.Done(),
      ]);
    }).pipe(
      Effect.provide(
        runtimeWith(() =>
          Stream.fromIterable(textParts(["Hi", " there"])).pipe(
            Stream.tap(() => Effect.sleep("10 seconds")),
          ),
        ),
      ),
    ),
  );

  it.effect(
    "reports a scripted tool call with its input and result, then streams the scripted answer",
    () =>
      Effect.gen(function* () {
        const asked = yield* Ref.make<ReadonlyArray<typeof Forecast.parametersSchema.Type>>([]);

        const handlers = ForecastToolkit.toLayer({
          forecast: (input) =>
            Ref.update(asked, (inputs) => [...inputs, input]).pipe(Effect.as("sunny")),
        });

        const script = [
          ModelStep.CallTools({
            calls: [{ name: "forecast", params: { city: "Vienna", days: 3 } }],
          }),
          ModelStep.Say({ words: ["Sunny", " in", " Vienna"] }),
        ];

        const events = yield* runTurn.pipe(
          Effect.provide(
            layerApi(ForecastToolkit, limits).pipe(
              Layer.provide([scriptedModel(replay(script)), handlers]),
            ),
          ),
        );

        expect(yield* Ref.get(asked)).toEqual([{ city: "Vienna", days: 3 }]);
        expect(events).toEqual([
          AgentEvent.ToolCallStarted({
            id: ToolCallId.make("call-1-0"),
            name: "forecast",
            params: { city: "Vienna", days: 3 },
          }),
          AgentEvent.ToolCallFinished({
            id: ToolCallId.make("call-1-0"),
            result: "sunny",
            failed: false,
          }),
          AgentEvent.TextDelta({ text: "Sunny" }),
          AgentEvent.TextDelta({ text: " in" }),
          AgentEvent.TextDelta({ text: " Vienna" }),
          AgentEvent.Done(),
        ]);
      }),
  );

  it.effect(
    "reports a tool that answered with its failure as failed, with what the model read",
    () => {
      class Unreachable extends Schema.TaggedError<Unreachable>()("Unreachable", {
        message: Schema.String,
      }) {}

      const Open = Tool.make("open", {
        description: "Opens a page",
        parameters: Schema.Struct({ url: Schema.String }),
        success: Schema.String,
        failure: Unreachable,
        failureMode: "return",
      });

      const OpenToolkit = Toolkit.make(Open);

      const handlers = OpenToolkit.toLayer({
        open: () => Effect.fail(new Unreachable({ message: "The computer is not available." })),
      });

      const script = [
        ModelStep.CallTools({ calls: [{ name: "open", params: { url: "https://example.com" } }] }),
        ModelStep.Say({ words: ["Could not open it"] }),
      ];

      return Effect.gen(function* () {
        const events = yield* runTurn;

        const [finished, ...more] = events.filter(AgentEvent.$is("ToolCallFinished"));

        expect(more).toEqual([]);
        expect(finished).toMatchObject({ id: "call-1-0", failed: true });
        expect(finished?.result).toContain("The computer is not available.");
      }).pipe(
        Effect.provide(
          layerApi(OpenToolkit, limits).pipe(
            Layer.provide([scriptedModel(replay(script)), handlers]),
          ),
        ),
      );
    },
  );

  it.effect("reports a result that is not text as JSON, the way the model reads it", () => {
    const Lookup = Tool.make("lookup", {
      description: "Finds a page",
      parameters: Schema.Struct({ query: Schema.String }),
      success: Schema.Struct({ title: Schema.String, words: Schema.Number }),
    });

    const LookupToolkit = Toolkit.make(Lookup);

    const handlers = LookupToolkit.toLayer({
      lookup: () => Effect.succeed({ title: "Example Domain", words: 28 }),
    });

    const script = [
      ModelStep.CallTools({ calls: [{ name: "lookup", params: { query: "example" } }] }),
      ModelStep.Say({ words: ["Found it"] }),
    ];

    return Effect.gen(function* () {
      const events = yield* runTurn;

      expect(events.filter(AgentEvent.$is("ToolCallFinished"))).toEqual([
        AgentEvent.ToolCallFinished({
          id: ToolCallId.make("call-1-0"),
          result: JSON.stringify({ title: "Example Domain", words: 28 }),
          failed: false,
        }),
      ]);
    }).pipe(
      Effect.provide(
        layerApi(LookupToolkit, limits).pipe(
          Layer.provide([scriptedModel(replay(script)), handlers]),
        ),
      ),
    );
  });
});
