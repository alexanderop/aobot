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

/** A Bot the server knows. */
export const BotId = Schema.String.pipe(Schema.brand("BotId"));

/** A decoded {@link BotId}. */
export type BotId = typeof BotId.Type;

/** One tool call a Bot made during a turn. The agent runtime names it, so it is unique within a turn. */
export const ToolCallId = Schema.String.pipe(Schema.brand("ToolCallId"));

/** A decoded {@link ToolCallId}. */
export type ToolCallId = typeof ToolCallId.Type;
