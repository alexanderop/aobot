import type { ChatEvent, ConversationId, MessageId, RunErrorCode, RunId } from "@aobot/domain";
import { Data, Duration, Effect, Schema, Stream } from "effect";
import {
  AgentEvent,
  type AgentError,
  type ModelFailed,
  type Stalled,
  type StepLimit,
} from "../agent/public.ts";

/** The person pressed stop. */
export class TurnStopped extends Schema.TaggedError<TurnStopped>()("TurnStopped", {}) {}

/** The names one turn's events carry: its conversation, its run and the Bot's message. */
export interface TurnIds {
  readonly conversationId: ConversationId;
  readonly runId: RunId;
  readonly messageId: MessageId;
}

/** Where a turn is: nothing said yet, partway through the Bot's message, or over. */
type TurnState = Data.TaggedEnum<{
  Waiting: {};
  Writing: {};
  Ended: {};
}>;

const TurnState = Data.taggedEnum<TurnState>();

/** What can happen next in a turn: more text, the Bot finished, or the turn failed. */
type TurnStep = Data.TaggedEnum<{
  Text: { readonly text: string };
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

/** The AG-UI events one step produces, and where the turn is afterwards. */
function advance(ids: TurnIds, state: TurnState, step: TurnStep): Transition {
  const content = (delta: string): ChatEvent => ({
    type: "TEXT_MESSAGE_CONTENT",
    messageId: ids.messageId,
    delta,
  });

  const start: ChatEvent = {
    type: "TEXT_MESSAGE_START",
    messageId: ids.messageId,
    role: "assistant",
  };

  const end: ChatEvent = { type: "TEXT_MESSAGE_END", messageId: ids.messageId };

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
    Waiting: () =>
      TurnStep.$match(step, {
        Text: ({ text }): Transition => [TurnState.Writing(), [start, content(text)]],
        Finish: (): Transition => [TurnState.Ended(), [finished]],
        Fail: ({ code, message }): Transition => [TurnState.Ended(), [failed(code, message)]],
      }),
    Writing: () =>
      TurnStep.$match(step, {
        Text: ({ text }): Transition => [state, [content(text)]],
        Finish: (): Transition => [TurnState.Ended(), [end, finished]],
        Fail: ({ code, message }): Transition => [TurnState.Ended(), [end, failed(code, message)]],
      }),
  });
}

/** The last event of a turn: after it the client treats the run as over. */
export function isTerminal(event: ChatEvent): boolean {
  return event.type === "RUN_FINISHED" || event.type === "RUN_ERROR";
}

/**
One turn as AG-UI events: `RUN_STARTED`, then the Bot's message as `TEXT_MESSAGE_START`, `…_CONTENT` and
`…_END`, then `RUN_FINISHED`, or `RUN_ERROR` saying why the turn ended early.
*/
export function turnEvents(
  ids: TurnIds,
  agentEvents: Stream.Stream<AgentEvent, AgentError | TurnStopped>,
): Stream.Stream<ChatEvent> {
  const steps = agentEvents.pipe(
    Stream.map(
      AgentEvent.$match({
        TextDelta: ({ text }) => TurnStep.Text({ text }),
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
        (): TurnState => TurnState.Waiting(),
        (state, step) => advance(ids, state, step),
      ),
    ),
  );
}
