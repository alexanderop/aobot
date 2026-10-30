import { describe, expect, it } from "vite-plus/test";
import { ChatEvent, decodeChatEvent } from "./chat-event.ts";

describe("ChatEvent", () => {
  it("decodes a known event from the wire", () => {
    const wire = JSON.parse('{"_tag":"TextDelta","text":"Hi"}');
    expect(decodeChatEvent(wire)).toEqual(ChatEvent.cases.TextDelta.make({ text: "Hi" }));
  });

  it("rejects an unknown event", () => {
    expect(() => decodeChatEvent(JSON.parse('{"_tag":"Explode"}'))).toThrow();
  });
});
