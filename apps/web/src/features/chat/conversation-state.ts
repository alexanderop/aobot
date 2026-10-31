import { Data, Option } from "effect";
import type {
  BotSummary,
  ChatEvent,
  ConversationSnapshot,
  Message,
  RunErrorCode,
} from "@aobot/domain";
import type { MessageId, RunId } from "@aobot/domain";

/**
Why a conversation is in the failed state. `stopped` is not here: the person asked for it, so a stopped
run is just idle. `busy` and `connection` come from the page, not from a run.
*/
export type FailureCode = Exclude<RunErrorCode, "stopped"> | "busy" | "connection";

/** Where a conversation stands: nothing running, a run in flight, or the last attempt failed. */
export type ConversationStatus = Data.TaggedEnum<{
  Idle: Record<never, never>;
  Running: { readonly runId: Option.Option<RunId> };
  Failed: { readonly code: FailureCode; readonly message: string };
}>;

/** Constructors and matchers for {@link ConversationStatus}. */
export const ConversationStatus = Data.taggedEnum<ConversationStatus>();

/** Everything the page knows about one conversation. */
export interface ConversationState {
  readonly bot: Option.Option<BotSummary>;
  readonly messages: ReadonlyArray<Message>;
  readonly status: ConversationStatus;
}

/** A conversation the page has not heard about yet. */
export const initialState: ConversationState = {
  bot: Option.none(),
  messages: [],
  status: ConversationStatus.Idle(),
};

/** Start from what the server stored. A run already in flight has no known run id yet. */
export function seedFromSnapshot(snapshot: ConversationSnapshot): ConversationState {
  return {
    bot: Option.some(snapshot.bot),
    messages: snapshot.messages,
    status: snapshot.isRunning
      ? ConversationStatus.Running({ runId: Option.none() })
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
    messages: [...state.messages, { id: messageId, role: "user", text }],
    status: ConversationStatus.Running({ runId: Option.none() }),
  };
}

/** The server refused a message because a turn is already running: take its bubble back. */
export function refuseMessage(state: ConversationState, messageId: MessageId): ConversationState {
  return {
    ...state,
    messages: state.messages.filter((message) => message.id !== messageId),
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
  const first = state.messages.findIndex((message) => message.id === messageId);

  return {
    ...state,
    messages: state.messages.filter(
      (message, index) => message.id !== messageId || index === first,
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
  messages: ReadonlyArray<Message>,
  messageId: MessageId,
  delta: string,
): ReadonlyArray<Message> {
  return messages.some((message) => message.id === messageId)
    ? messages.map((message) =>
        message.id === messageId ? { ...message, text: message.text + delta } : message,
      )
    : [...messages, { id: messageId, role: "assistant", text: delta }];
}

/** Fold one streamed event into the conversation. Pure: the same events always give the same state. */
export function foldChatEvent(state: ConversationState, event: ChatEvent): ConversationState {
  switch (event.type) {
    case "RUN_STARTED":
      return { ...state, status: ConversationStatus.Running({ runId: Option.some(event.runId) }) };

    case "TEXT_MESSAGE_START":
      return { ...state, messages: appendAssistantText(state.messages, event.messageId, "") };

    case "TEXT_MESSAGE_CONTENT":
      return {
        ...state,
        messages: appendAssistantText(state.messages, event.messageId, event.delta),
      };

    case "TEXT_MESSAGE_END":
      return state;

    case "RUN_FINISHED":
      return { ...state, status: ConversationStatus.Idle() };

    case "RUN_ERROR":
      return {
        ...state,
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
