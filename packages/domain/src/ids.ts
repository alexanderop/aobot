import { Schema } from "effect";

/** One conversation between a person and a Bot. The page picks it and keeps it in the URL. */
export const ConversationId = Schema.String.pipe(Schema.brand("ConversationId"));

/** A decoded {@link ConversationId}. */
export type ConversationId = typeof ConversationId.Type;

/** One agent turn, from the person's message to the Bot's last word. */
export const RunId = Schema.String.pipe(Schema.brand("RunId"));

/** A decoded {@link RunId}. */
export type RunId = typeof RunId.Type;

/** One message in a conversation, written by the person or by the Bot. */
export const MessageId = Schema.String.pipe(Schema.brand("MessageId"));

/** A decoded {@link MessageId}. */
export type MessageId = typeof MessageId.Type;

/**
A Bot the server knows, such as `researcher`: up to 64 lowercase letters, digits and dashes, since it
travels in a URL, a header and the reason a refusal gives, and is written into every audit row.
*/
export const BotId = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(64), Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/u)),
  Schema.brand("BotId"),
);

/** A decoded {@link BotId}. */
export type BotId = typeof BotId.Type;

/** One tool call a Bot made during a turn. The agent runtime names it, so it is unique within a turn. */
export const ToolCallId = Schema.String.pipe(Schema.brand("ToolCallId"));

/** A decoded {@link ToolCallId}. */
export type ToolCallId = typeof ToolCallId.Type;
