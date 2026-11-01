import { ToolCallId } from "@aobot/domain";
import { Data, Option, Result, Schema } from "effect";
import { gatewayMcpName } from "../../gateway/public.ts";
import { AgentEvent, ModelFailed } from "../agent-runtime.ts";

const MessageChunk = Schema.Struct({
  sessionUpdate: Schema.Literal("agent_message_chunk"),
  content: Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
});

const optionalOrNull = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(Schema.NullOr(schema));

/** ACP's `tool_call` and `tool_call_update`, with only the fields we read. */
const ToolCallUpdate = Schema.Struct({
  sessionUpdate: Schema.Literals(["tool_call", "tool_call_update"]),
  toolCallId: ToolCallId,
  name: optionalOrNull(Schema.String),
  title: optionalOrNull(Schema.String),
  status: optionalOrNull(Schema.String),
  rawInput: Schema.optionalKey(Schema.Json),
  rawOutput: Schema.optionalKey(Schema.Json),
  content: optionalOrNull(Schema.Array(Schema.Json)),
});

type ToolCallUpdate = typeof ToolCallUpdate.Type;

const decodeUpdate = Schema.decodeUnknownOption(
  Schema.Struct({ update: Schema.Union([MessageChunk, ToolCallUpdate]) }),
);

const isString = Schema.is(Schema.String);

const decodeTextContent = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("content"),
    content: Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  }),
);

/**
Where one tool call the agent reported stands. ACP's `pending` means the input may still be streaming
(Claude Code sends `tool_call` with an empty `rawInput` and fills it in later), so a call is told to the
turn only once it runs or ends, when its input is settled.
*/
type ToolCall = Data.TaggedEnum<{
  Pending: {
    readonly name: Option.Option<string>;
    readonly title: Option.Option<string>;
    readonly input: Schema.Json;
  };
  Running: {};
  Ended: {};
}>;

const ToolCall = Data.taggedEnum<ToolCall>();

type PendingCall = Data.TaggedEnum.Value<ToolCall, "Pending">;

/** Every tool call of one turn so far, by ACP `toolCallId`. */
export type ToolCalls = ReadonlyMap<ToolCallId, ToolCall>;

/** Where the turn's tool calls stand after an update, and what the turn hears of it. */
type ToolCallsTransition = readonly [ToolCalls, ReadonlyArray<AgentEvent>];

/** A turn before the agent has called any tool. */
export const noToolCalls: ToolCalls = new Map();

const CodexMcpInput = Schema.Struct({
  server: Schema.String,
  tool: Schema.String,
  arguments: Schema.Json,
});

const decodeCodexMcpInput = Schema.decodeUnknownOption(CodexMcpInput);

/**
How each CLI names a gateway tool, and where it keeps the tool's input: Claude Code `mcp__aobot__navigate`,
Codex `mcp.aobot.navigate` with the input under `arguments`, OpenCode `aobot_navigate`.
*/
const gatewayToolForms: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly params: (input: Schema.Json) => Schema.Json;
}> = [
  { pattern: new RegExp(`^mcp__${gatewayMcpName}__(.+)$`), params: (input) => input },
  {
    pattern: new RegExp(`^mcp\\.${gatewayMcpName}\\.(.+)$`),
    params: (input) =>
      Option.match(decodeCodexMcpInput(input), {
        onNone: () => input,
        onSome: (codex) => codex.arguments,
      }),
  },
  { pattern: new RegExp(`^${gatewayMcpName}_(.+)$`), params: (input) => input },
];

/** The tool as the transcript names it: a gateway tool by its own name, anything else as the CLI calls it. */
function toolStarted(id: ToolCallId, call: PendingCall): AgentEvent {
  const reported = Option.getOrElse(
    Option.orElse(call.name, () => call.title),
    () => "tool",
  );

  for (const form of gatewayToolForms) {
    const match = form.pattern.exec(reported);

    if (match?.[1] !== undefined) {
      return AgentEvent.ToolCallStarted({ id, name: match[1], params: form.params(call.input) });
    }
  }

  return AgentEvent.ToolCallStarted({ id, name: reported, params: call.input });
}

/** What the tool answered: its text content blocks, else its raw output. */
function toolResult(update: ToolCallUpdate, failed: boolean): string {
  const texts = (update.content ?? []).flatMap((block) =>
    Option.match(decodeTextContent(block), {
      onNone: () => [],
      onSome: ({ content }) => [content.text],
    }),
  );

  if (texts.length > 0) return texts.join("\n");

  if (update.rawOutput !== undefined && update.rawOutput !== null) {
    return isString(update.rawOutput) ? update.rawOutput : JSON.stringify(update.rawOutput);
  }

  return failed ? "The tool failed." : "";
}

/** A call the agent has just announced: no name, title or input yet. */
const unseen = ToolCall.Pending({ name: Option.none(), title: Option.none(), input: {} });

/** A pending call with what this update adds. Fields the update leaves out keep their earlier value. */
function refine(call: PendingCall, update: ToolCallUpdate): PendingCall {
  return ToolCall.Pending({
    name: Option.orElse(Option.fromNullishOr(update.name), () => call.name),
    title: Option.orElse(Option.fromNullishOr(update.title), () => call.title),
    input: update.rawInput ?? call.input,
  });
}

/** One tool call update applied: where the call stands now, and what the turn hears of it. */
function applyToolCall(calls: ToolCalls, update: ToolCallUpdate): ToolCallsTransition {
  const id = update.toolCallId;
  const set = (call: ToolCall) => new Map(calls).set(id, call);
  const finishes = update.status === "completed" || update.status === "failed";

  const finished = () => {
    const failed = update.status === "failed";

    return AgentEvent.ToolCallFinished({ id, result: toolResult(update, failed), failed });
  };

  return ToolCall.$match(calls.get(id) ?? unseen, {
    Ended: (): ToolCallsTransition => [calls, []],
    Running: (): ToolCallsTransition =>
      finishes ? [set(ToolCall.Ended()), [finished()]] : [calls, []],
    Pending: (call): ToolCallsTransition => {
      const refined = refine(call, update);

      if (finishes) return [set(ToolCall.Ended()), [toolStarted(id, refined), finished()]];

      return update.status === "in_progress"
        ? [set(ToolCall.Running()), [toolStarted(id, refined)]]
        : [set(refined), []];
    },
  });
}

/**
What a `session/update` adds to the turn: the text of an `agent_message_chunk`, and tool calls once
they run and again when they end. Thoughts, plans and usage reports are not part of the answer.
*/
export function sessionUpdateEvents(calls: ToolCalls, params: Schema.Json): ToolCallsTransition {
  return Option.match(decodeUpdate(params), {
    onNone: () => [calls, []],
    onSome: ({ update }) =>
      update.sessionUpdate === "agent_message_chunk"
        ? [
            calls,
            update.content.text.length > 0
              ? [AgentEvent.TextDelta({ text: update.content.text })]
              : [],
          ]
        : applyToolCall(calls, update),
  });
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
