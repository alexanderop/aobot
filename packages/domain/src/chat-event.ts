import { Schema } from "effect";
import { ConversationId, MessageId, RunId } from "./ids.ts";

/**
Why a run ended without finishing. `busy` never appears here: a second message is refused by
{@link ConversationBusy} before any run starts.
*/
export const RunErrorCode = Schema.Literals(["stalled", "step_limit", "model", "stopped"]);

/** A decoded {@link RunErrorCode}. */
export type RunErrorCode = typeof RunErrorCode.Type;

/**
One event in a streamed chat turn. Names and fields are AG-UI's (`@ag-ui/core` 1.0.2), discriminated by
`type`, so an AG-UI client can read the stream through a thin adapter. `threadId` is our conversation.
*/
export const ChatEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("RUN_STARTED"),
    threadId: ConversationId,
    runId: RunId,
  }),
  Schema.Struct({
    type: Schema.Literal("TEXT_MESSAGE_START"),
    messageId: MessageId,
    role: Schema.Literal("assistant"),
  }),
  Schema.Struct({
    type: Schema.Literal("TEXT_MESSAGE_CONTENT"),
    messageId: MessageId,
    delta: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("TEXT_MESSAGE_END"),
    messageId: MessageId,
  }),
  Schema.Struct({
    type: Schema.Literal("RUN_FINISHED"),
    threadId: ConversationId,
    runId: RunId,
  }),
  Schema.Struct({
    type: Schema.Literal("RUN_ERROR"),
    message: Schema.String,
    code: RunErrorCode,
  }),
]).pipe(Schema.toTaggedUnion("type"));

/** A decoded {@link ChatEvent}. */
export type ChatEvent = typeof ChatEvent.Type;

/** Decode an event from the wire, failing on anything that is not a known event. */
export const decodeChatEvent = Schema.decodeUnknownSync(ChatEvent);

/** Encode an event for the wire. */
export const encodeChatEvent = Schema.encodeSync(ChatEvent);
