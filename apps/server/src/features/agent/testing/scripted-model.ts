import { Effect, Layer, Ref, Stream } from "effect";
import { type AiError, LanguageModel, type Response } from "effect/ai";

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

/** The parts of an answer that only calls one tool. */
export function toolCallParts(name: string, call: number): Array<Response.StreamPartEncoded> {
  return [
    { type: "tool-call", id: `call-${call}`, name, params: {} },
    { type: "finish", reason: "tool-calls", usage },
  ];
}
