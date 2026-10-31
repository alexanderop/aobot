import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { ChatEvent } from "./chat-event.ts";
import { BotId, ConversationId, MessageId } from "./ids.ts";

/** What the page shows about a Bot: its name in the header pill and the composer placeholder. */
export const BotSummary = Schema.Struct({
  id: BotId,
  name: Schema.String,
});

/** A decoded {@link BotSummary}. */
export type BotSummary = typeof BotSummary.Type;

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

/** What the page loads when it opens a conversation, so a reload shows what was said. */
export const ConversationSnapshot = Schema.Struct({
  bot: BotSummary,
  messages: Schema.Array(Message),
  isRunning: Schema.Boolean,
});

/** A decoded {@link ConversationSnapshot}. */
export type ConversationSnapshot = typeof ConversationSnapshot.Type;

/** The person's message. The page picks `messageId` so it can show the bubble before the server answers. */
export const SendMessage = Schema.Struct({
  conversationId: ConversationId,
  messageId: MessageId,
  text: Schema.NonEmptyString,
});

/** A turn is already running in this conversation. The second message is refused, not queued. */
export class ConversationBusy extends Schema.TaggedError<ConversationBusy>()("ConversationBusy", {
  conversationId: ConversationId,
}) {}

/** The chat API the server serves and the page calls. */
export class ChatRpcs extends RpcGroup.make(
  Rpc.make("Chat.open", { payload: ConversationRef, success: ConversationSnapshot }),
  Rpc.make("Chat.send", {
    payload: SendMessage,
    success: ChatEvent,
    error: ConversationBusy,
    stream: true,
  }),
  Rpc.make("Chat.stop", { payload: ConversationRef }),
) {}
