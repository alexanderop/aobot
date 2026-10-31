import { describe, expect, it } from "vite-plus/test";
import { Option, Result, type Schema } from "effect";
import { AgentEvent, ModelFailed } from "../agent-runtime.ts";
import { promptOutcome, sessionUpdateEvent } from "./session-updates.ts";

const update = (update: Schema.JsonObject) => ({ sessionId: "s", update });

describe("sessionUpdateEvent", () => {
  it("turns a text chunk of the agent's message into text of the answer", () => {
    const chunk = update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hi" },
    });

    expect(sessionUpdateEvent(chunk)).toEqual(Option.some(AgentEvent.TextDelta({ text: "Hi" })));
  });

  it.each([
    [
      "an empty chunk",
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } },
    ],
    ["a thought", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } }],
    ["a tool call", { sessionUpdate: "tool_call", toolCallId: "t", title: "env" }],
    ["usage", { sessionUpdate: "usage_update", used: 1, size: 10 }],
    ["an image", { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "" } }],
  ])("leaves %s out of the answer", (_, body) => {
    expect(sessionUpdateEvent(update(body))).toEqual(Option.none());
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
