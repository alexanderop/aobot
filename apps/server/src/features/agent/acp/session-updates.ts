import { Option, Result, Schema } from "effect";
import { AgentEvent, ModelFailed } from "../agent-runtime.ts";

const MessageChunk = Schema.Struct({
  update: Schema.Struct({
    sessionUpdate: Schema.Literal("agent_message_chunk"),
    content: Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  }),
});

const decodeMessageChunk = Schema.decodeUnknownOption(MessageChunk);

/**
What a `session/update` adds to the Bot's answer: the text of an `agent_message_chunk`. Thoughts, plans,
tool calls and usage reports are not part of the answer.
*/
export function sessionUpdateEvent(params: Schema.Json): Option.Option<AgentEvent> {
  return decodeMessageChunk(params).pipe(
    Option.map(({ update }) => update.content.text),
    Option.filter((text) => text.length > 0),
    Option.map((text) => AgentEvent.TextDelta({ text })),
  );
}

const StopReason = Schema.Literals([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
]);

const PromptResponse = Schema.Struct({ stopReason: Schema.String });

const decodePromptResponse = Schema.decodeUnknownOption(PromptResponse);

const stopped = (why: string) =>
  Result.fail(new ModelFailed({ reason: `The agent stopped: ${why}.` }));

/** How a turn ends for each reason ACP gives. Only `end_turn` is an answer. */
const stopReasons = {
  end_turn: Result.succeed(AgentEvent.Done()),
  max_tokens: stopped("it reached its token limit"),
  max_turn_requests: stopped("it made as many model requests as one turn allows"),
  refusal: stopped("the model refused to answer"),
  cancelled: stopped("the turn was cancelled"),
} satisfies { readonly [R in typeof StopReason.Type]: Result.Result<AgentEvent, ModelFailed> };

const isStopReason = Schema.is(StopReason);

/** How the `session/prompt` response ends the turn. */
export function promptOutcome(response: Schema.Json): Result.Result<AgentEvent, ModelFailed> {
  return Option.match(decodePromptResponse(response), {
    onNone: () => stopped("its answer to session/prompt had no stop reason"),
    onSome: ({ stopReason }) =>
      isStopReason(stopReason)
        ? stopReasons[stopReason]
        : stopped(`an unknown reason, ${stopReason}`),
  });
}
