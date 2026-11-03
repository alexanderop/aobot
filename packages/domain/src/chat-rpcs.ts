import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { ChatEvent } from "./chat-event.ts";
import { BotSummary, UnknownBot } from "./bot.ts";
import { BotId, ConversationId, MessageId } from "./ids.ts";
import { BotPaused, PauseUnknown } from "./pause-rpcs.ts";

/** One stored message. A Bot message is stored once its run ends, with the text it got to. */
export const Message = Schema.Struct({
  id: MessageId,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
});

/** A decoded {@link Message}. */
export type Message = typeof Message.Type;

/** Names one conversation. */
export const ConversationRef = Schema.Struct({
  conversationId: ConversationId,
});

/**
Opens a conversation with the Bot the page picked. A conversation belongs to one Bot from its first
message on, so for one that has messages and another Bot the server refuses with
{@link ConversationOfAnotherBot}.
*/
export const OpenConversation = Schema.Struct({
  conversationId: ConversationId,
  botId: BotId,
});

/** What the page loads when it opens a conversation, so a reload shows what was said. */
export const ConversationSnapshot = Schema.Struct({
  bot: BotSummary,
  messages: Schema.Array(Message),
  isRunning: Schema.Boolean,
});

/** A decoded {@link ConversationSnapshot}. */
export type ConversationSnapshot = typeof ConversationSnapshot.Type;

/**
The person's message. The page picks `messageId` so it can show the bubble before the server answers.
`botId` is the Bot a new conversation belongs to from this message on; one that has messages refuses
another Bot with {@link ConversationOfAnotherBot}.
*/
export const SendMessage = Schema.Struct({
  conversationId: ConversationId,
  botId: BotId,
  messageId: MessageId,
  text: Schema.NonEmptyString,
});

/** A turn is already running in this conversation. The second message is refused, not queued. */
export class ConversationBusy extends Schema.TaggedError<ConversationBusy>()("ConversationBusy", {
  conversationId: ConversationId,
}) {}

/**
The message id was already stored, so this send is a retry of one the server has seen. It is refused,
not replayed: no run starts and nothing is stored. Open the conversation to see how the first send ended.
*/
export class MessageAlreadySent extends Schema.TaggedError<MessageAlreadySent>()(
  "MessageAlreadySent",
  { messageId: MessageId },
) {}

/**
The page named another Bot than the one the conversation belongs to, so nothing was opened or sent.
`botId` is the conversation's own Bot, for the page to follow.
*/
export class ConversationOfAnotherBot extends Schema.TaggedError<ConversationOfAnotherBot>()(
  "ConversationOfAnotherBot",
  { conversationId: ConversationId, botId: BotId },
) {}

/**
The chat API the server serves and the page calls. A send to a paused Bot, or to one whose pause the
server cannot read, is refused with {@link BotPaused} or {@link PauseUnknown} before anything is stored.
*/
export class ChatRpcs extends RpcGroup.make(
  Rpc.make("Chat.open", {
    payload: OpenConversation,
    success: ConversationSnapshot,
    error: Schema.Union([UnknownBot, ConversationOfAnotherBot]),
  }),
  Rpc.make("Chat.send", {
    payload: SendMessage,
    success: ChatEvent,
    error: Schema.Union([
      ConversationBusy,
      MessageAlreadySent,
      UnknownBot,
      ConversationOfAnotherBot,
      BotPaused,
      PauseUnknown,
    ]),
    stream: true,
  }),
  Rpc.make("Chat.stop", { payload: ConversationRef }),
) {}
