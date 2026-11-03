import { Array as Arr, Data, Option } from "effect";
import type {
  BotSummary,
  ChatEvent,
  ConversationSnapshot,
  Message,
  RunErrorCode,
} from "@aobot/domain";
import type { BotId, MessageId, RunId, ToolCallId } from "@aobot/domain";

/**
Why a conversation is in the failed state. `stopped` is not here: the person asked for it, so a stopped
run is just idle. `busy`, `connection`, `unknown_bot` and `another_bot` come from the page, not from a
run.
*/
export type FailureCode =
  | Exclude<RunErrorCode, "stopped">
  | "busy"
  | "connection"
  | "unknown_bot"
  | "another_bot";

/**
What the server said when the page opened a conversation with a Bot: opened, with the Bot it belongs to,
or refused because it belongs to another Bot or the server knows no such Bot.
*/
export type OpenOutcome = Data.TaggedEnum<{
  Opened: { readonly bot: BotSummary };
  OfAnotherBot: { readonly botId: BotId };
  UnknownBot: { readonly botId: BotId };
}>;

/** Constructors and matchers for {@link OpenOutcome}. */
export const OpenOutcome = Data.taggedEnum<OpenOutcome>();

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

/** A message the server turned away, which the composer offers again. */
export interface Unsent {
  readonly id: MessageId;
  readonly text: string;
}

/** Everything the page knows about one conversation. */
export interface ConversationState {
  readonly bot: Option.Option<BotSummary>;
  readonly transcript: ReadonlyArray<TranscriptItem>;
  readonly status: ConversationStatus;
  readonly unsent: Option.Option<Unsent>;
}

/** A conversation the page has not heard about yet. */
export const initialState: ConversationState = {
  bot: Option.none(),
  transcript: [],
  status: ConversationStatus.Idle(),
  unsent: Option.none(),
};

function isMessage(
  item: TranscriptItem,
  messageId: MessageId,
): item is Data.TaggedEnum.Value<TranscriptItem, "Message"> {
  return TranscriptItem.$is("Message")(item) && item.id === messageId;
}

/**
Start from what the server stored. A run already in flight was started elsewhere, so a stop goes out at
once. A message the server turned away is the page's own, so it is kept.
*/
export function seedFromSnapshot(
  state: ConversationState,
  snapshot: ConversationSnapshot,
): ConversationState {
  return {
    ...state,
    bot: Option.some(snapshot.bot),
    transcript: snapshot.messages.map((message) => TranscriptItem.Message(message)),
    status: snapshot.isRunning
      ? ConversationStatus.Running({ phase: RunPhase.Observed() })
      : ConversationStatus.Idle(),
  };
}

/** Show the person's message before the server answers. Whatever the composer offered again went with it. */
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
    unsent: Option.none(),
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

/**
The server knows no Bot by this id, as when `bots.yaml` no longer lists it. Nothing was stored, so a
message sent to it is taken back too.
*/
export function refuseUnknownBot(
  state: ConversationState,
  botId: BotId,
  messageId: Option.Option<MessageId>,
): ConversationState {
  const transcript = Option.match(messageId, {
    onNone: () => state.transcript,
    onSome: (id) => state.transcript.filter((item) => !isMessage(item, id)),
  });

  return {
    ...state,
    transcript,
    status: ConversationStatus.Failed({
      code: "unknown_bot",
      message: `The server knows no Bot called ${botId}. Pick one in the sidebar.`,
    }),
  };
}

/**
The conversation belongs to another Bot than the one the message was sent to, as when another tab sent
its first message to that Bot. Nothing was stored, so the message is taken back and offered again in the
composer, where it stays while the page follows the conversation to its own Bot.
*/
export function refuseForAnotherBot(
  state: ConversationState,
  botId: BotId,
  messageId: MessageId,
): ConversationState {
  const refused = Arr.findFirst(state.transcript, (item) => isMessage(item, messageId));

  return {
    ...state,
    transcript: state.transcript.filter((item) => !isMessage(item, messageId)),
    unsent: Option.map(refused, (message) => ({ id: messageId, text: message.text })),
    status: ConversationStatus.Failed({
      code: "another_bot",
      message: `This conversation is ${botId}'s, so the message was not sent.`,
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

function isPersonMessage(
  item: TranscriptItem,
): item is Data.TaggedEnum.Value<TranscriptItem, "Message"> {
  return TranscriptItem.$is("Message")(item) && item.role === "user";
}

/** The person's message the run in flight answers, which names its turn; none while nothing runs. */
export function runningTurn(state: ConversationState): Option.Option<MessageId> {
  return isRunning(state)
    ? Option.map(Arr.findLast(state.transcript, isPersonMessage), ({ id }) => id)
    : Option.none();
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
Whether the Bot uses its computer this turn, so its screen is worth showing: a run this page started is in
flight and has called a tool this turn. A page that joined a running turn sees none of its steps, nor when
it ends, so it keeps the screen folded.
*/
export function usesComputer(state: ConversationState): boolean {
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
