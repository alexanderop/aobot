import { describe, expect, it } from "vite-plus/test";
import { BotId, ConversationId, MessageId, RunId, ToolCallId } from "@aobot/domain";
import type { ChatEvent } from "@aobot/domain";
import { Option } from "effect";
import {
  ConversationStatus,
  acknowledgeDuplicate,
  appendUserMessage,
  failIfStillRunning,
  foldChatEvent,
  initialState,
  isRunning,
  refuseMessage,
  seedFromSnapshot,
} from "./conversation-state.ts";
import type { ConversationState } from "./conversation-state.ts";
import { ToolCallStatus, TranscriptItem } from "./conversation-state.ts";

const conversationId = ConversationId.make("c1");

const runId = RunId.make("r1");

const userId = MessageId.make("u1");

const botId = MessageId.make("b1");

const reply = (...deltas: string[]): ChatEvent[] => [
  { type: "RUN_STARTED", threadId: conversationId, runId },
  { type: "TEXT_MESSAGE_START", messageId: botId, role: "assistant" },
  ...deltas.map((delta): ChatEvent => ({ type: "TEXT_MESSAGE_CONTENT", messageId: botId, delta })),
  { type: "TEXT_MESSAGE_END", messageId: botId },
];

const texts = (state: ConversationState) =>
  state.transcript.flatMap((item) => (TranscriptItem.$is("Message")(item) ? [item.text] : []));

const fold = (state: ConversationState, events: ChatEvent[]) => events.reduce(foldChatEvent, state);

const asked = appendUserMessage(initialState, userId, "Say hi in five words");

describe("given a message the person just sent", () => {
  it("shows the message at once and counts as running", () => {
    expect(asked.transcript).toEqual([
      TranscriptItem.Message({ id: userId, role: "user", text: "Say hi in five words" }),
    ]);
    expect(isRunning(asked)).toBe(true);
  });

  describe("when the Bot's answer streams in", () => {
    const midway = fold(asked, reply("Hello", " there", " from"));

    it("grows one Bot message word by word and keeps running", () => {
      expect(texts(midway)).toEqual(["Say hi in five words", "Hello there from"]);
      expect(isRunning(midway)).toBe(true);
    });

    it("stops running once the run finishes", () => {
      const done = fold(midway, [{ type: "RUN_FINISHED", threadId: conversationId, runId }]);

      expect(isRunning(done)).toBe(false);
      expect(done.transcript).toHaveLength(2);
    });

    it("treats a stop as the end of the run, not as an error, and keeps the words so far", () => {
      const stopped = fold(midway, [{ type: "RUN_ERROR", message: "stopped", code: "stopped" }]);

      expect(isRunning(stopped)).toBe(false);
      expect(ConversationStatus.$is("Idle")(stopped.status)).toBe(true);
      expect(texts(stopped).at(-1)).toBe("Hello there from");
    });

    it("reports a failed run with its reason", () => {
      const failed = fold(midway, [{ type: "RUN_ERROR", message: "no reply", code: "stalled" }]);

      expect(isRunning(failed)).toBe(false);
      expect(failed.status).toEqual(
        ConversationStatus.Failed({ code: "stalled", message: "no reply" }),
      );
    });
  });

  it("takes the bubble back and says why when the server refuses it as busy", () => {
    const refused = refuseMessage(asked, userId);

    expect(refused.transcript).toEqual([]);
    expect(ConversationStatus.$is("Failed")(refused.status)).toBe(true);
    expect(refused.status).toMatchObject({ code: "busy" });
  });

  it("keeps one bubble and goes idle when the server already had the message", () => {
    const seeded = seedFromSnapshot({
      bot: { id: BotId.make("bot"), name: "Chief" },
      messages: [{ id: userId, role: "user", text: "Say hi in five words" }],
      isRunning: false,
    });

    const resent = acknowledgeDuplicate(
      appendUserMessage(seeded, userId, "Say hi in five words"),
      userId,
    );

    expect(resent.transcript).toEqual(seeded.transcript);
    expect(isRunning(resent)).toBe(false);
  });

  it("fails when the stream ends without a finish or an error", () => {
    const ended = failIfStillRunning(fold(asked, reply("Hel")));

    expect(ConversationStatus.$is("Failed")(ended.status)).toBe(true);
    expect(ended.status).toMatchObject({ code: "connection" });
  });

  it("leaves a finished conversation alone when the stream ends", () => {
    const done = fold(asked, [{ type: "RUN_FINISHED", threadId: conversationId, runId }]);

    expect(failIfStillRunning(done)).toBe(done);
  });
});

describe("given a stored conversation", () => {
  it("opens with its messages, its Bot, and idle when nothing is running", () => {
    const state = seedFromSnapshot({
      bot: { id: BotId.make("bot"), name: "Chief" },
      messages: [{ id: userId, role: "user", text: "hi" }],
      isRunning: false,
    });

    expect(Option.map(state.bot, (bot) => bot.name)).toEqual(Option.some("Chief"));
    expect(state.transcript).toHaveLength(1);
    expect(isRunning(state)).toBe(false);
  });

  it("opens as running when a turn is still in flight", () => {
    const state = seedFromSnapshot({
      bot: { id: BotId.make("bot"), name: "Chief" },
      messages: [],
      isRunning: true,
    });

    expect(isRunning(state)).toBe(true);
  });
});

describe("given a Bot that calls a tool mid-answer", () => {
  const callId = ToolCallId.make("call-1");

  const afterId = MessageId.make("b2");

  const toolCall: ChatEvent[] = [
    { type: "TEXT_MESSAGE_END", messageId: botId },
    {
      type: "TOOL_CALL_START",
      toolCallId: callId,
      toolCallName: "navigate",
      parentMessageId: botId,
    },
    { type: "TOOL_CALL_ARGS", toolCallId: callId, delta: '{"url":' },
    { type: "TOOL_CALL_ARGS", toolCallId: callId, delta: '"https://example.com"}' },
    { type: "TOOL_CALL_END", toolCallId: callId },
  ];

  const running = fold(asked, [...reply("Opening it.").slice(0, -1), ...toolCall]);

  it("shows the call after the text before it, running, with its whole input", () => {
    expect(running.transcript.at(-1)).toEqual(
      TranscriptItem.ToolCall({
        id: callId,
        name: "navigate",
        args: '{"url":"https://example.com"}',
        status: ToolCallStatus.Running(),
      }),
    );
    expect(texts(running)).toEqual(["Say hi in five words", "Opening it."]);
  });

  it("marks the call done with its result, and puts the text after it in a new message", () => {
    const answered = fold(running, [
      {
        type: "TOOL_CALL_RESULT",
        messageId: MessageId.make("r1"),
        toolCallId: callId,
        content: "Opened",
        role: "tool",
      },
      { type: "TEXT_MESSAGE_START", messageId: afterId, role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: afterId, delta: "Example Domain" },
      { type: "TEXT_MESSAGE_END", messageId: afterId },
      { type: "RUN_FINISHED", threadId: conversationId, runId },
    ]);

    expect(answered.transcript.map((item) => item._tag)).toEqual([
      "Message",
      "Message",
      "ToolCall",
      "Message",
    ]);
    expect(answered.transcript[2]).toMatchObject({
      status: ToolCallStatus.Done({ result: "Opened" }),
    });
    expect(texts(answered)).toEqual(["Say hi in five words", "Opening it.", "Example Domain"]);
  });

  it("marks the call failed with what the tool answered when its result says it failed", () => {
    const failed = fold(running, [
      {
        type: "TOOL_CALL_RESULT",
        messageId: MessageId.make("r1"),
        toolCallId: callId,
        content: "The computer is not available.",
        role: "tool",
        metadata: { failed: true },
      },
      { type: "RUN_FINISHED", threadId: conversationId, runId },
    ]);

    expect(failed.transcript.at(-1)).toMatchObject({
      status: ToolCallStatus.Failed({ result: "The computer is not available." }),
    });
  });

  it("marks a call that never got its result unfinished once the run ends", () => {
    const stopped = fold(running, [{ type: "RUN_ERROR", message: "Stopped.", code: "stopped" }]);

    expect(stopped.transcript.at(-1)).toMatchObject({ status: ToolCallStatus.Unfinished() });
  });
});
