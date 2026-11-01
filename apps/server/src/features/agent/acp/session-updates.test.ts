import { ToolCallId } from "@aobot/domain";
import { describe, expect, it } from "vite-plus/test";
import { Result, type Schema } from "effect";
import { AgentEvent, ModelFailed } from "../agent-runtime.ts";
import { noToolCalls, promptOutcome, sessionUpdateEvents } from "./session-updates.ts";

const update = (update: Schema.JsonObject) => ({ sessionId: "s", update });

/** The events a run of updates adds to the turn, in order. */
function eventsOf(updates: ReadonlyArray<Schema.JsonObject>): ReadonlyArray<AgentEvent> {
  let calls = noToolCalls;
  const events: Array<AgentEvent> = [];

  for (const body of updates) {
    const [next, added] = sessionUpdateEvents(calls, update(body));
    calls = next;
    events.push(...added);
  }

  return events;
}

const textResult = (text: string) => [{ type: "content", content: { type: "text", text } }];

describe("sessionUpdateEvents", () => {
  it("turns a text chunk of the agent's message into text of the answer", () => {
    expect(
      eventsOf([{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } }]),
    ).toEqual([AgentEvent.TextDelta({ text: "Hi" })]);
  });

  it.each([
    [
      "an empty chunk",
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } },
    ],
    ["a thought", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } }],
    ["usage", { sessionUpdate: "usage_update", used: 1, size: 10 }],
    ["an image", { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "" } }],
    ["a tool call still pending", { sessionUpdate: "tool_call", toolCallId: "t", title: "env" }],
  ])("leaves %s out of the answer", (_, body) => {
    expect(eventsOf([body])).toEqual([]);
  });

  it("waits for Claude Code's streamed input to settle before reporting the call", () => {
    const events = eventsOf([
      {
        sessionUpdate: "tool_call",
        toolCallId: "toolu_1",
        name: "mcp__aobot__navigate",
        title: "mcp__aobot__navigate",
        status: "pending",
        rawInput: {},
      },
      { sessionUpdate: "tool_call_update", toolCallId: "toolu_1", rawInput: { url: "https://ex" } },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_1",
        rawInput: { url: "https://example.com" },
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_1",
        status: "completed",
        content: textResult("Opened"),
      },
    ]);

    expect(events).toEqual([
      AgentEvent.ToolCallStarted({
        id: ToolCallId.make("toolu_1"),
        name: "navigate",
        params: { url: "https://example.com" },
      }),
      AgentEvent.ToolCallFinished({
        id: ToolCallId.make("toolu_1"),
        result: "Opened",
        failed: false,
      }),
    ]);
  });

  it("reports a call once it runs, and its result once it ends", () => {
    const running = eventsOf([
      {
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "mcp.aobot.snapshot",
        status: "in_progress",
        rawInput: { server: "aobot", tool: "snapshot", arguments: {} },
      },
    ]);

    expect(running).toEqual([
      AgentEvent.ToolCallStarted({ id: ToolCallId.make("call_1"), name: "snapshot", params: {} }),
    ]);

    const ended = eventsOf([
      {
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "mcp.aobot.snapshot",
        status: "in_progress",
        rawInput: { server: "aobot", tool: "snapshot", arguments: {} },
      },
      { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "in_progress" },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "completed",
        rawOutput: { title: "Example Domain" },
      },
      { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed" },
    ]);

    expect(ended).toEqual([
      ...running,
      AgentEvent.ToolCallFinished({
        id: ToolCallId.make("call_1"),
        result: '{"title":"Example Domain"}',
        failed: false,
      }),
    ]);
  });

  it.each([
    ["Claude Code", "mcp__aobot__navigate"],
    ["Codex", "mcp.aobot.navigate"],
    ["OpenCode", "aobot_navigate"],
  ])("names a gateway tool the way %s reports it by the tool's own name", (_, reported) => {
    const [started] = eventsOf([
      {
        sessionUpdate: "tool_call",
        toolCallId: "t",
        title: reported,
        status: "in_progress",
        rawInput: { url: "https://example.com" },
      },
    ]);

    expect(started).toEqual(
      AgentEvent.ToolCallStarted({
        id: ToolCallId.make("t"),
        name: "navigate",
        params: { url: "https://example.com" },
      }),
    );
  });

  it("reports a call the agent says failed as failed, with the text the tool answered", () => {
    const events = eventsOf([
      {
        sessionUpdate: "tool_call",
        toolCallId: "t",
        title: "mcp__aobot__navigate",
        status: "in_progress",
        rawInput: { url: "https://example.com" },
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t",
        status: "failed",
        content: textResult("The computer is not available."),
      },
    ]);

    expect(events.at(-1)).toEqual(
      AgentEvent.ToolCallFinished({
        id: ToolCallId.make("t"),
        result: "The computer is not available.",
        failed: true,
      }),
    );
  });

  it("keeps the name of a tool outside the gateway, and says a failure without output failed", () => {
    expect(
      eventsOf([
        { sessionUpdate: "tool_call", toolCallId: "t", title: "Read file", rawInput: {} },
        { sessionUpdate: "tool_call_update", toolCallId: "t", status: "failed" },
      ]),
    ).toEqual([
      AgentEvent.ToolCallStarted({ id: ToolCallId.make("t"), name: "Read file", params: {} }),
      AgentEvent.ToolCallFinished({
        id: ToolCallId.make("t"),
        result: "The tool failed.",
        failed: true,
      }),
    ]);
  });
});

describe("promptOutcome", () => {
  it("ends the turn with an answer on end_turn", () => {
    expect(promptOutcome({ stopReason: "end_turn" })).toEqual(Result.succeed(AgentEvent.Done()));
  });

  it.each(["max_tokens", "max_turn_requests", "refusal", "cancelled", "something_new"])(
    "fails the turn on %s",
    (stopReason) => {
      const outcome = promptOutcome({ stopReason });

      expect(Result.isFailure(outcome)).toBe(true);
    },
  );

  it("fails the turn on an answer without a stop reason", () => {
    expect(promptOutcome(null)).toEqual(
      Result.fail(
        new ModelFailed({
          reason: "The agent stopped: its answer to session/prompt had no stop reason.",
        }),
      ),
    );
  });
});
