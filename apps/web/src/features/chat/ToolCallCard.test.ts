import { describe, expect, it } from "vite-plus/test";
import { ToolCallId } from "@aobot/domain";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolCallCard } from "./ToolCallCard.tsx";
import { ToolCallStatus } from "./conversation-state.ts";
import type { ToolCall } from "./conversation-state.ts";

const call = (name: string, args: string, status: ToolCallStatus): ToolCall => ({
  id: ToolCallId.make("call-1"),
  name,
  args,
  status,
});

const draw = (toolCall: ToolCall) =>
  renderToStaticMarkup(createElement(ToolCallCard, { call: toolCall }));

describe("ToolCallCard", () => {
  it("says which page navigate opened once it is done", () => {
    const html = draw(
      call("navigate", '{"url":"https://example.com"}', ToolCallStatus.Done({ result: "ok" })),
    );

    expect(html).toContain('data-tool="navigate"');
    expect(html).toContain("Opened https://example.com");
  });

  it("shows navigate as still opening while it runs", () => {
    expect(
      draw(call("navigate", '{"url":"https://example.com"}', ToolCallStatus.Running())),
    ).toContain("Opening https://example.com…");
  });

  it("folds what snapshot read behind a summary", () => {
    const html = draw(
      call("snapshot", "{}", ToolCallStatus.Done({ result: "heading Example Domain" })),
    );

    expect(html).toContain("Read the page");
    expect(html).toMatch(/<details[^>]*>.*heading Example Domain.*<\/details>/s);
  });

  it("draws a tool it has no renderer for by name, with its input", () => {
    const html = draw(call("click", '{"ref":"e3"}', ToolCallStatus.Unfinished()));

    expect(html).toContain('data-tool="click"');
    expect(html).toContain("Did not finish click");
    expect(html).toContain("{&quot;ref&quot;:&quot;e3&quot;}");
  });
});
