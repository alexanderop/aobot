import { Array as Arr, Data, Option } from "effect";
import type {
  BotSummary,
  ChatEvent,
  ConversationSnapshot,
  Message,
  RunErrorCode,
} from "@aobot/domain";
import type { MessageId, RunId, ToolCallId } from "@aobot/domain";

/**
Why a conversation is in the failed state. `stopped` is not here: the person asked for it, so a stopped
run is just idle. `busy` and `connection` come from the page, not from a run.
*/
export type FailureCode = Exclude<RunErrorCode, "stopped"> | "busy" | "connection";

/**
How far a run in flight has got, as this page sees it. The server can only stop a run it has started, so
a stop pressed while `Sending` waits here until the run starts.
*/
type RunPhase = Data.TaggedEnum<{
  Sending: { readonly stopRequested: boolean };
  Started: { readonly runId: RunId };
  Observed: Record<never, never>;
}>;

const RunPhase = Data.taggedEnum<RunPhase>();

/** Where a conversation stands: nothing running, a run in flight, or the last attempt failed. */
export type ConversationStatus = Data.TaggedEnum<{
  Idle: Record<never, never>;
  Running: { readonly phase: RunPhase };
  Failed: { readonly code: FailureCode; readonly message: string };
}>;

/** Constructors and matchers for {@link ConversationStatus}. */
export const ConversationStatus = Data.taggedEnum<ConversationStatus>();

/**
Where one tool call stands: running, answered, answered with a failure, or cut off when its run ended
without a result.
*/
export type ToolCallStatus = Data.TaggedEnum<{
  Running: Record<never, never>;
  Done: { readonly result: string };
  Failed: { readonly result: string };
  Unfinished: Record<never, never>;
}>;

/** Constructors and matchers for {@link ToolCallStatus}. */
export const ToolCallStatus = Data.taggedEnum<ToolCallStatus>();

/** One tool call a Bot made. `args` is its input as the JSON text AG-UI streamed. */
export interface ToolCall {
  readonly id: ToolCallId;
  readonly name: string;
  readonly args: string;
  readonly status: ToolCallStatus;
}

/** One entry in the transcript, in the order it happened: a message, or a tool call between messages. */
export type TranscriptItem = Data.TaggedEnum<{
  Message: Message;
  ToolCall: ToolCall;
}>;

/** Constructors and matchers for {@link TranscriptItem}. */
export const TranscriptItem = Data.taggedEnum<TranscriptItem>();

/** Everything the page knows about one conversation. */
export interface ConversationState {
  readonly bot: Option.Option<BotSummary>;
  readonly transcript: ReadonlyArray<TranscriptItem>;
  readonly status: ConversationStatus;
}

/** A conversation the page has not heard about yet. */
export const initialState: ConversationState = {
  bot: Option.none(),
  transcript: [],
  status: ConversationStatus.Idle(),
};

function isMessage(
  item: TranscriptItem,
  messageId: MessageId,
): item is Data.TaggedEnum.Value<TranscriptItem, "Message"> {
  return TranscriptItem.$is("Message")(item) && item.id === messageId;
}

/** Start from what the server stored. A run already in flight was started elsewhere, so a stop goes out at once. */
export function seedFromSnapshot(snapshot: ConversationSnapshot): ConversationState {
  return {
    bot: Option.some(snapshot.bot),
    transcript: snapshot.messages.map((message) => TranscriptItem.Message(message)),
    status: snapshot.isRunning
      ? ConversationStatus.Running({ phase: RunPhase.Observed() })
      : ConversationStatus.Idle(),
  };
}

/** Show the person's message before the server answers. */
export function appendUserMessage(
  state: ConversationState,
  messageId: MessageId,
  text: string,
): ConversationState {
  return {
    ...state,
    transcript: [
      ...state.transcript,
      TranscriptItem.Message({ id: messageId, role: "user", text }),
    ],
    status: ConversationStatus.Running({ phase: RunPhase.Sending({ stopRequested: false }) }),
  };
}

/** The server refused a message because a turn is already running: take its bubble back. */
export function refuseMessage(state: ConversationState, messageId: MessageId): ConversationState {
  return {
    ...state,
    transcript: state.transcript.filter((item) => !isMessage(item, messageId)),
    status: ConversationStatus.Failed({
      code: "busy",
      message: "Bot is still answering. Wait for it to finish or stop it.",
    }),
  };
}

/** The server already had this message, so no run started: keep one bubble for it and stop waiting. */
export function acknowledgeDuplicate(
  state: ConversationState,
  messageId: MessageId,
): ConversationState {
  const first = state.transcript.findIndex((item) => isMessage(item, messageId));

  return {
    ...state,
    transcript: state.transcript.filter(
      (item, index) => !isMessage(item, messageId) || index === first,
    ),
    status: ConversationStatus.Idle(),
  };
}

/** The socket dropped or the call failed. Text that already arrived stays. */
export function failConnection(state: ConversationState, message: string): ConversationState {
  return { ...state, status: ConversationStatus.Failed({ code: "connection", message }) };
}

/** A stream that ended without a finish or an error event leaves the conversation running: end it as a failure. */
export function failIfStillRunning(state: ConversationState): ConversationState {
  return ConversationStatus.$is("Running")(state.status)
    ? failConnection(state, "The connection closed before the Bot finished.")
    : state;
}

function appendAssistantText(
  transcript: ReadonlyArray<TranscriptItem>,
  messageId: MessageId,
  delta: string,
): ReadonlyArray<TranscriptItem> {
  return transcript.some((item) => isMessage(item, messageId))
    ? transcript.map((item) =>
        isMessage(item, messageId)
          ? TranscriptItem.Message({ ...item, text: item.text + delta })
          : item,
      )
    : [...transcript, TranscriptItem.Message({ id: messageId, role: "assistant", text: delta })];
}

function updateToolCall(
  transcript: ReadonlyArray<TranscriptItem>,
  toolCallId: ToolCallId,
  update: (call: ToolCall) => ToolCall,
): ReadonlyArray<TranscriptItem> {
  return transcript.map((item) =>
    TranscriptItem.$is("ToolCall")(item) && item.id === toolCallId
      ? TranscriptItem.ToolCall(update(item))
      : item,
  );
}

/** A run that ended leaves no tool call running: one still waiting for its result never gets it. */
function endToolCalls(transcript: ReadonlyArray<TranscriptItem>): ReadonlyArray<TranscriptItem> {
  return transcript.map((item) =>
    TranscriptItem.$is("ToolCall")(item) && ToolCallStatus.$is("Running")(item.status)
      ? TranscriptItem.ToolCall({ ...item, status: ToolCallStatus.Unfinished() })
      : item,
  );
}

/** Fold one streamed event into the conversation. Pure: the same events always give the same state. */
export function foldChatEvent(state: ConversationState, event: ChatEvent): ConversationState {
  switch (event.type) {
    case "RUN_STARTED":
      return {
        ...state,
        status: ConversationStatus.Running({ phase: RunPhase.Started({ runId: event.runId }) }),
      };

    case "TEXT_MESSAGE_START":
      return { ...state, transcript: appendAssistantText(state.transcript, event.messageId, "") };

    case "TEXT_MESSAGE_CONTENT":
      return {
        ...state,
        transcript: appendAssistantText(state.transcript, event.messageId, event.delta),
      };

    case "TEXT_MESSAGE_END":
    case "TOOL_CALL_END":
      return state;

    case "TOOL_CALL_START":
      return {
        ...state,
        transcript: [
          ...state.transcript,
          TranscriptItem.ToolCall({
            id: event.toolCallId,
            name: event.toolCallName,
            args: "",
            status: ToolCallStatus.Running(),
          }),
        ],
      };

    case "TOOL_CALL_ARGS":
      return {
        ...state,
        transcript: updateToolCall(state.transcript, event.toolCallId, (call) => ({
          ...call,
          args: call.args + event.delta,
        })),
      };

    case "TOOL_CALL_RESULT":
      return {
        ...state,
        transcript: updateToolCall(state.transcript, event.toolCallId, (call) => ({
          ...call,
          status:
            event.metadata?.failed === true
              ? ToolCallStatus.Failed({ result: event.content })
              : ToolCallStatus.Done({ result: event.content }),
        })),
      };

    case "RUN_FINISHED":
      return {
        ...state,
        transcript: endToolCalls(state.transcript),
        status: ConversationStatus.Idle(),
      };

    case "RUN_ERROR":
      return {
        ...state,
        transcript: endToolCalls(state.transcript),
        status:
          event.code === "stopped"
            ? ConversationStatus.Idle()
            : ConversationStatus.Failed({ code: event.code, message: event.message }),
      };
  }
}

/** True while a run is in flight. */
export function isRunning(state: ConversationState): boolean {
  return ConversationStatus.$is("Running")(state.status);
}

/** Whether a tool call came after the person's last message. */
function calledToolThisTurn(transcript: ReadonlyArray<TranscriptItem>): boolean {
  return Option.exists(
    Arr.findLast(
      transcript,
      (item) => TranscriptItem.$is("ToolCall")(item) || item.role === "user",
    ),
    TranscriptItem.$is("ToolCall"),
  );
}

/**
Whether the Bot's screen is worth showing: a run this page started is in flight and has called a tool this
turn. A page that joined a running turn sees none of its steps, nor when it ends, so it keeps the screen
folded.
*/
export function showsScreen(state: ConversationState): boolean {
  return isRunning(state) && calledToolThisTurn(state.transcript);
}

function isStopWaiting(state: ConversationState): boolean {
  return (
    ConversationStatus.$is("Running")(state.status) &&
    RunPhase.$is("Sending")(state.status.phase) &&
    state.status.phase.stopRequested
  );
}

/**
The person pressed stop. Returns whether to send `Chat.stop` now: not while the run is still `Sending`,
where the stop is held in the state instead, because the server would drop it.
*/
export function requestStop(state: ConversationState): [boolean, ConversationState] {
  if (!ConversationStatus.$is("Running")(state.status)) return [false, state];

  if (RunPhase.$is("Sending")(state.status.phase)) {
    return [
      false,
      {
        ...state,
        status: ConversationStatus.Running({ phase: RunPhase.Sending({ stopRequested: true }) }),
      },
    ];
  }

  return [true, state];
}

/** Fold one streamed event, and say whether a held stop must go out now that the run has started. */
export function receiveEvent(
  state: ConversationState,
  event: ChatEvent,
): [boolean, ConversationState] {
  return [event.type === "RUN_STARTED" && isStopWaiting(state), foldChatEvent(state, event)];
}
