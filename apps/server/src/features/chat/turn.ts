import {
  type ChatEvent,
  type ConversationId,
  MessageId,
  type RunErrorCode,
  type RunId,
  type ToolCallId,
} from "@aobot/domain";
import { Data, Duration, Effect, Option, Schema, Stream } from "effect";
import {
  AgentEvent,
  type AgentError,
  type ModelFailed,
  type Stalled,
  type StepLimit,
} from "../agent/public.ts";

/** The person pressed stop. */
export class TurnStopped extends Schema.TaggedError<TurnStopped>()("TurnStopped", {}) {}

/** The names one turn's events carry: its conversation, its run and the Bot's first message. */
export interface TurnIds {
  readonly conversationId: ConversationId;
  readonly runId: RunId;
  readonly messageId: MessageId;
}

/**
The id of the Bot's message number `segment` in this turn. A turn's text is split into one message per
stretch between tool calls, and the first keeps the id the turn was started with.
*/
function segmentMessageId(ids: TurnIds, segment: number): MessageId {
  return segment === 0 ? ids.messageId : MessageId.make(`${ids.messageId}-${segment}`);
}

/**
Where a turn is: between messages (nothing said yet, or the last message closed by a tool call),
partway through message `segment`, or over.
*/
type TurnState = Data.TaggedEnum<{
  Waiting: { readonly segment: number };
  Writing: { readonly segment: number };
  Ended: {};
}>;

const TurnState = Data.taggedEnum<TurnState>();

/** What can happen next in a turn: more text, a tool call or its result, the Bot finished, or the turn failed. */
type TurnStep = Data.TaggedEnum<{
  Text: { readonly text: string };
  CallTool: { readonly id: ToolCallId; readonly name: string; readonly params: unknown };
  ToolResult: { readonly id: ToolCallId; readonly result: string };
  Finish: {};
  Fail: { readonly code: RunErrorCode; readonly message: string };
}>;

const TurnStep = Data.taggedEnum<TurnStep>();

function stalledStep(error: Stalled) {
  const seconds = Duration.toSeconds(Duration.millis(error.waitedMs));

  return TurnStep.Fail({
    code: "stalled",
    message: `The model sent nothing for ${seconds} seconds, so this turn was stopped. Send your message again to retry.`,
  });
}

function stepLimitStep(error: StepLimit) {
  return TurnStep.Fail({
    code: "step_limit",
    message: `The Bot took ${error.steps} steps without finishing, so this turn was stopped.`,
  });
}

function modelFailedStep(error: ModelFailed) {
  return Effect.logWarning("The model provider failed a turn").pipe(
    Effect.annotateLogs({ reason: error.reason }),
    Effect.as(
      TurnStep.Fail({
        code: "model",
        message: "The model provider could not answer. The server log says why.",
      }),
    ),
  );
}

const stoppedStep = TurnStep.Fail({ code: "stopped", message: "Stopped." });

/** Where the turn is after a step, and the AG-UI events the step produced. */
type Transition = readonly [TurnState, ReadonlyArray<ChatEvent>];

/**
A tool call as AG-UI streams it: start, the whole input as one args delta, end. `parentMessageId` is the
Bot's message the call follows, when there is one.
*/
function toolCallEvents(
  call: Data.TaggedEnum.Value<TurnStep, "CallTool">,
  parentMessageId: Option.Option<MessageId>,
): ReadonlyArray<ChatEvent> {
  return [
    {
      type: "TOOL_CALL_START",
      toolCallId: call.id,
      toolCallName: call.name,
      ...Option.match(parentMessageId, {
        onNone: () => ({}),
        onSome: (id) => ({ parentMessageId: id }),
      }),
    },
    { type: "TOOL_CALL_ARGS", toolCallId: call.id, delta: JSON.stringify(call.params ?? {}) },
    { type: "TOOL_CALL_END", toolCallId: call.id },
  ];
}

/** The AG-UI events one step produces, and where the turn is afterwards. */
function advance(ids: TurnIds, state: TurnState, step: TurnStep): Transition {
  const start = (segment: number): ChatEvent => ({
    type: "TEXT_MESSAGE_START",
    messageId: segmentMessageId(ids, segment),
    role: "assistant",
  });

  const content = (segment: number, delta: string): ChatEvent => ({
    type: "TEXT_MESSAGE_CONTENT",
    messageId: segmentMessageId(ids, segment),
    delta,
  });

  const end = (segment: number): ChatEvent => ({
    type: "TEXT_MESSAGE_END",
    messageId: segmentMessageId(ids, segment),
  });

  const result = ({ id, result }: Data.TaggedEnum.Value<TurnStep, "ToolResult">): ChatEvent => ({
    type: "TOOL_CALL_RESULT",
    messageId: MessageId.make(`${ids.messageId}-result-${id}`),
    toolCallId: id,
    content: result,
    role: "tool",
  });

  const finished: ChatEvent = {
    type: "RUN_FINISHED",
    threadId: ids.conversationId,
    runId: ids.runId,
  };

  const failed = (code: RunErrorCode, message: string): ChatEvent => ({
    type: "RUN_ERROR",
    code,
    message,
  });

  return TurnState.$match(state, {
    Ended: (): Transition => [state, []],
    Waiting: ({ segment }) =>
      TurnStep.$match(step, {
        Text: ({ text }): Transition => [
          TurnState.Writing({ segment }),
          [start(segment), content(segment, text)],
        ],
        CallTool: (call): Transition => [state, toolCallEvents(call, Option.none())],
        ToolResult: (done): Transition => [state, [result(done)]],
        Finish: (): Transition => [TurnState.Ended(), [finished]],
        Fail: ({ code, message }): Transition => [TurnState.Ended(), [failed(code, message)]],
      }),
    Writing: ({ segment }) =>
      TurnStep.$match(step, {
        Text: ({ text }): Transition => [state, [content(segment, text)]],
        CallTool: (call): Transition => [
          TurnState.Waiting({ segment: segment + 1 }),
          [end(segment), ...toolCallEvents(call, Option.some(segmentMessageId(ids, segment)))],
        ],
        ToolResult: (done): Transition => [state, [result(done)]],
        Finish: (): Transition => [TurnState.Ended(), [end(segment), finished]],
        Fail: ({ code, message }): Transition => [
          TurnState.Ended(),
          [end(segment), failed(code, message)],
        ],
      }),
  });
}

/** The last event of a turn: after it the client treats the run as over. */
export function isTerminal(event: ChatEvent): boolean {
  return event.type === "RUN_FINISHED" || event.type === "RUN_ERROR";
}

/**
One turn as AG-UI events: `RUN_STARTED`, then the Bot's messages as `TEXT_MESSAGE_START`, `…_CONTENT` and
`…_END`, with each tool call between them as `TOOL_CALL_START`, `…_ARGS`, `…_END` and later
`TOOL_CALL_RESULT`, then `RUN_FINISHED`, or `RUN_ERROR` saying why the turn ended early. Text after a
tool call is a new message.
*/
export function turnEvents(
  ids: TurnIds,
  agentEvents: Stream.Stream<AgentEvent, AgentError | TurnStopped>,
): Stream.Stream<ChatEvent> {
  const steps = agentEvents.pipe(
    Stream.map(
      AgentEvent.$match({
        TextDelta: ({ text }) => TurnStep.Text({ text }),
        ToolCallStarted: ({ id, name, params }) => TurnStep.CallTool({ id, name, params }),
        ToolCallFinished: ({ id, result }) => TurnStep.ToolResult({ id, result }),
        Done: () => TurnStep.Finish(),
      }),
    ),
    Stream.catchTags({
      Stalled: (error) => Stream.make(stalledStep(error)),
      StepLimit: (error) => Stream.make(stepLimitStep(error)),
      ModelFailed: (error) => Stream.fromEffect(modelFailedStep(error)),
      TurnStopped: () => Stream.make(stoppedStep),
    }),
  );

  const started: ChatEvent = {
    type: "RUN_STARTED",
    threadId: ids.conversationId,
    runId: ids.runId,
  };

  return Stream.concat(
    Stream.make(started),
    steps.pipe(
      Stream.mapAccum(
        (): TurnState => TurnState.Waiting({ segment: 0 }),
        (state, step) => advance(ids, state, step),
      ),
    ),
  );
}
