import { describe, expect, it } from "vite-plus/test";
import { decodeChatEvent, encodeChatEvent } from "./chat-event.ts";

const agUiExamples = [
  { type: "RUN_STARTED", threadId: "thread-1", runId: "run-1" },
  { type: "TEXT_MESSAGE_START", messageId: "message-1", role: "assistant" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: "message-1", delta: "Hello" },
  { type: "TEXT_MESSAGE_END", messageId: "message-1" },
  { type: "TOOL_CALL_START", toolCallId: "call-1", toolCallName: "navigate" },
  {
    type: "TOOL_CALL_START",
    toolCallId: "call-1",
    toolCallName: "navigate",
    parentMessageId: "message-1",
  },
  { type: "TOOL_CALL_ARGS", toolCallId: "call-1", delta: '{"url":"https://example.com"}' },
  { type: "TOOL_CALL_END", toolCallId: "call-1" },
  { type: "TOOL_CALL_RESULT", messageId: "message-2", toolCallId: "call-1", content: "Opened." },
  {
    type: "TOOL_CALL_RESULT",
    messageId: "message-2",
    toolCallId: "call-1",
    content: "Opened.",
    role: "tool",
  },
  {
    type: "TOOL_CALL_RESULT",
    messageId: "message-2",
    toolCallId: "call-1",
    content: "The computer is not available.",
    role: "tool",
    metadata: { failed: true },
  },
  { type: "RUN_FINISHED", threadId: "thread-1", runId: "run-1" },
  { type: "RUN_ERROR", message: "The model went quiet.", code: "stalled" },
];

describe("ChatEvent", () => {
  it.each(agUiExamples)("round-trips the AG-UI $type example", (example) => {
    expect(encodeChatEvent(decodeChatEvent(example))).toEqual(example);
  });

  it("rejects an event type AG-UI 1.0.2 has but we do not stream", () => {
    expect(() =>
      decodeChatEvent({ type: "TOOL_CALL_CHUNK", toolCallId: "call-1", delta: "{}" }),
    ).toThrow();
  });

  it("rejects a tool result from a role other than tool", () => {
    expect(() =>
      decodeChatEvent({
        type: "TOOL_CALL_RESULT",
        messageId: "message-2",
        toolCallId: "call-1",
        content: "Opened.",
        role: "assistant",
      }),
    ).toThrow();
  });

  it("rejects an unknown event type", () => {
    expect(() => decodeChatEvent({ type: "RUN_PAUSED", threadId: "thread-1" })).toThrow();
  });

  it("rejects a RUN_ERROR code outside the known reasons", () => {
    expect(() => decodeChatEvent({ type: "RUN_ERROR", message: "No.", code: "busy" })).toThrow();
  });
});
