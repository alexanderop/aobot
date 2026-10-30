import { Schema } from "effect";

/** One event in a streamed chat turn, as the server sends it to the page and the desktop app. */
export const ChatEvent = Schema.TaggedUnion({
  TextDelta: { text: Schema.String },
  ToolCall: { tool: Schema.String },
  TurnDone: { sessionId: Schema.String },
});

/** A decoded {@link ChatEvent}. */
export type ChatEvent = typeof ChatEvent.Type;

/** Decode an event from the wire, failing on anything that is not a known event. */
export const decodeChatEvent = Schema.decodeUnknownSync(ChatEvent);
