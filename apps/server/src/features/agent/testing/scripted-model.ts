import { Array, Effect, Layer, Option, Ref, Stream } from "effect";
import { type AiError, LanguageModel, type Response } from "effect/ai";
import {
  type ModelScript,
  ModelStep,
  type ScriptedToolCall,
  scriptOverrun,
} from "./model-script.ts";

/** One model call's answer, as the provider would stream it. */
export type ScriptedAnswer = Stream.Stream<Response.StreamPartEncoded, AiError.AiError>;

/**
A `LanguageModel` that answers from a script instead of a provider. `answer` receives the 1-based
number of the call, so a script can say something different on each step.
*/
export function scriptedModel(answer: (call: number) => ScriptedAnswer) {
  return Layer.effect(
    LanguageModel.LanguageModel,
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);

      return yield* LanguageModel.make({
        generateText: () => Effect.die("the scripted model only streams"),
        streamText: () =>
          Stream.unwrap(
            Effect.map(
              Ref.updateAndGet(calls, (n) => n + 1),
              answer,
            ),
          ),
      });
    }),
  );
}

/** Answer call N with step N of `script`. A call past the end dies, naming the script's length. */
export function replay(script: ModelScript): (call: number) => ScriptedAnswer {
  return (call) =>
    Option.match(Array.get(script, call - 1), {
      onNone: () => Stream.die(scriptOverrun(script, call)),
      onSome: (step) =>
        Stream.fromIterable(
          ModelStep.$match(step, {
            Say: ({ words }) => textParts(words),
            CallTools: ({ calls }) => toolCallParts(calls, call),
          }),
        ),
    });
}

const usage = {
  inputTokens: { uncached: 1, total: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: undefined, reasoning: undefined },
};

/** The parts of a plain text answer, one delta per word. */
export function textParts(words: ReadonlyArray<string>): Array<Response.StreamPartEncoded> {
  return [
    { type: "text-start", id: "text-1" },
    ...words.map((delta): Response.StreamPartEncoded => ({
      type: "text-delta",
      id: "text-1",
      delta,
    })),
    { type: "text-end", id: "text-1" },
    { type: "finish", reason: "stop", usage },
  ];
}

/** The parts of an answer that only calls tools. `call` keeps the ids unique across calls. */
export function toolCallParts(
  calls: ReadonlyArray<ScriptedToolCall>,
  call: number,
): Array<Response.StreamPartEncoded> {
  return [
    ...calls.map(({ name, params }, index): Response.StreamPartEncoded => ({
      type: "tool-call",
      id: `call-${call}-${index}`,
      name,
      params,
    })),
    { type: "finish", reason: "tool-calls", usage },
  ];
}
