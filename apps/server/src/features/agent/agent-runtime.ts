import type { Message, ToolCallId } from "@aobot/domain";
import { Context, Data, Schema, type Stream } from "effect";

/**
What a running turn reports, in order: text as it arrives, each tool call when the Bot makes it and
again when its result is back, then `Done` once the Bot has answered. `params` is the tool's input as
JSON; `result` is what the tool answered, as the text the model reads, and `failed` says the tool could
not do what it was asked.
*/
export type AgentEvent = Data.TaggedEnum<{
  TextDelta: { readonly text: string };
  ToolCallStarted: { readonly id: ToolCallId; readonly name: string; readonly params: unknown };
  ToolCallFinished: { readonly id: ToolCallId; readonly result: string; readonly failed: boolean };
  Done: {};
}>;

/** Constructors and matchers for {@link AgentEvent}. */
export const AgentEvent = Data.taggedEnum<AgentEvent>();

/** The model sent nothing for the stall limit, so the turn was cancelled. */
export class Stalled extends Schema.TaggedError<Stalled>()("Stalled", {
  waitedMs: Schema.Number,
}) {}

/** The Bot used every step it may take in one turn without answering. */
export class StepLimit extends Schema.TaggedError<StepLimit>()("StepLimit", {
  steps: Schema.Number,
}) {}

/** The model provider refused or broke the request. */
export class ModelFailed extends Schema.TaggedError<ModelFailed>()("ModelFailed", {
  reason: Schema.String,
}) {}

/** Why a turn ended without an answer. */
export type AgentError = Stalled | StepLimit | ModelFailed;

/** One turn to run: the Bot's instructions and the conversation so far, ending with the person's message. */
export interface Turn {
  readonly instructions: string;
  readonly history: ReadonlyArray<Message>;
}

/** Runs the think-act loop for one turn. `api` today; `acp` arrives with E0-5. */
export class AgentRuntime extends Context.Service<
  AgentRuntime,
  {
    readonly run: (turn: Turn) => Stream.Stream<AgentEvent, AgentError>;
  }
>()("aobot/AgentRuntime") {}
