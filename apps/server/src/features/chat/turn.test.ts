import { ConversationId, MessageId, RunId, ToolCallId } from "@aobot/domain";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { AgentEvent, StepLimit } from "../agent/public.ts";
import { turnEvents } from "./turn.ts";

const ids = {
  conversationId: ConversationId.make("conversation-1"),
  runId: RunId.make("run-1"),
  messageId: MessageId.make("message-1"),
};

const call = (id: string) =>
  AgentEvent.ToolCallStarted({ id: ToolCallId.make(id), name: "snapshot", params: {} });

const done = (id: string) =>
  AgentEvent.ToolCallFinished({ id: ToolCallId.make(id), result: "Example Domain" });

describe("turnEvents", () => {
  it.effect("starts a turn with tool calls and no parent message, then opens the answer", () =>
    Effect.gen(function* () {
      const events = yield* turnEvents(
        ids,
        Stream.make(
          call("a"),
          done("a"),
          call("b"),
          done("b"),
          AgentEvent.TextDelta({ text: "Hi" }),
        ),
      ).pipe(Stream.runCollect);

      expect(events.filter((event) => event.type === "TOOL_CALL_START")).toEqual([
        { type: "TOOL_CALL_START", toolCallId: "a", toolCallName: "snapshot" },
        { type: "TOOL_CALL_START", toolCallId: "b", toolCallName: "snapshot" },
      ]);
      expect(events.at(-1)).toEqual({
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "message-1",
        delta: "Hi",
      });
    }),
  );

  it.effect("gives each stretch of text between tool calls its own message", () =>
    Effect.gen(function* () {
      const events = yield* turnEvents(
        ids,
        Stream.make(
          AgentEvent.TextDelta({ text: "One" }),
          call("a"),
          AgentEvent.TextDelta({ text: "Two" }),
          call("b"),
          done("a"),
          done("b"),
          AgentEvent.TextDelta({ text: "Three" }),
          AgentEvent.Done(),
        ),
      ).pipe(Stream.runCollect);

      const started = events.flatMap((event) =>
        event.type === "TEXT_MESSAGE_START" ? [event.messageId] : [],
      );

      expect(started).toEqual(["message-1", "message-1-1", "message-1-2"]);
      expect(events.filter((event) => event.type === "TOOL_CALL_START")).toEqual([
        {
          type: "TOOL_CALL_START",
          toolCallId: "a",
          toolCallName: "snapshot",
          parentMessageId: "message-1",
        },
        {
          type: "TOOL_CALL_START",
          toolCallId: "b",
          toolCallName: "snapshot",
          parentMessageId: "message-1-1",
        },
      ]);
    }),
  );

  it.effect("ends the run after a tool call without closing a message a second time", () =>
    Effect.gen(function* () {
      const events = yield* turnEvents(
        ids,
        Stream.concat(
          Stream.make(AgentEvent.TextDelta({ text: "One" }), call("a")),
          Stream.fail(new StepLimit({ steps: 8 })),
        ),
      ).pipe(Stream.runCollect);

      expect(events.map((event) => event.type).slice(-3)).toEqual([
        "TOOL_CALL_ARGS",
        "TOOL_CALL_END",
        "RUN_ERROR",
      ]);
    }),
  );
});
