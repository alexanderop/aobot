import type { Message } from "@aobot/domain";
import { Duration, Effect, Layer, Ref, Result, Stream } from "effect";
import { AiError, Chat, LanguageModel, type Prompt, type Tool, type Toolkit } from "effect/ai";
import {
  AgentEvent,
  type AgentError,
  AgentRuntime,
  ModelFailed,
  Stalled,
  StepLimit,
  type Turn,
} from "./agent-runtime.ts";

/** How far one turn may go before it is stopped. */
export interface AgentLimits {
  readonly maxSteps: number;
  readonly stallTimeout: Duration.Duration;
}

function toPrompt(turn: Turn): ReadonlyArray<Prompt.MessageEncoded> {
  return [
    { role: "system", content: turn.instructions },
    ...turn.history.map((message: Message) => ({ role: message.role, content: message.text })),
  ];
}

/** What the toolkit's handlers and schemas need to run, provided once when the runtime is built. */
type ToolServices<Tools extends Record<string, Tool.Any>> =
  | Tool.HandlerServices<Tools[keyof Tools]>
  | Tool.ResultDecodingServices<Tools[keyof Tools]>
  | Tool.ParametersEncodingServices<Tools[keyof Tools]>;

function modelFailed<E>(error: E): ModelFailed {
  return new ModelFailed({
    reason: AiError.isAiError(error)
      ? error.message
      : "A tool failed in a way the model cannot see.",
  });
}

/**
The `api` runtime: our own loop over `effect/ai` `Chat`. One step is one model call; a step that calls
tools leads to another, up to `maxSteps`.
*/
export function layerApi<Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
  limits: AgentLimits,
) {
  return Layer.effect(
    AgentRuntime,
    Effect.gen(function* () {
      const model = yield* LanguageModel.LanguageModel;
      const tools = yield* toolkit;
      const toolServices = yield* Effect.context<ToolServices<Tools>>();

      const stalled = () =>
        Stream.fail(new Stalled({ waitedMs: Duration.toMillis(limits.stallTimeout) }));

      const step = (
        chat: Chat.Chat,
        index: number,
      ): Stream.Stream<AgentEvent, AgentError, LanguageModel.LanguageModel | ToolServices<Tools>> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const calledTools = yield* Ref.make(false);

            const answer = chat.streamText({ prompt: [], toolkit: tools }).pipe(
              Stream.mapError(modelFailed),
              Stream.timeoutOrElse({ duration: limits.stallTimeout, orElse: stalled }),
              Stream.tap((part) =>
                part.type === "tool-call" ? Ref.set(calledTools, true) : Effect.void,
              ),
              Stream.filterMap((part) =>
                part.type === "text-delta" && part.delta.length > 0
                  ? Result.succeed(AgentEvent.TextDelta({ text: part.delta }))
                  : Result.fail(part),
              ),
            );

            const next = Stream.unwrap(
              Ref.get(calledTools).pipe(
                Effect.map((called) => {
                  if (!called) return Stream.make(AgentEvent.Done());

                  if (index >= limits.maxSteps) {
                    return Stream.fail(new StepLimit({ steps: limits.maxSteps }));
                  }

                  return step(chat, index + 1);
                }),
              ),
            );

            return Stream.concat(answer, next);
          }),
        );

      const run = (turn: Turn) =>
        Stream.unwrap(Effect.map(Chat.fromPrompt(toPrompt(turn)), (chat) => step(chat, 1))).pipe(
          Stream.provideService(LanguageModel.LanguageModel, model),
          Stream.provideContext(toolServices),
          Stream.withSpan("AgentRuntime.run"),
        );

      return AgentRuntime.of({ run });
    }),
  );
}
