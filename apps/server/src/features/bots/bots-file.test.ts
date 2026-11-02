import { readFileSync } from "node:fs";
import { ToolName } from "@aobot/domain";
import { Option, Result } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { readBotsFile } from "./bots-file.ts";

const researcher = `
  - id: researcher
    name: Researcher
    group: research
    instructions: You are Researcher.
    tools: [snapshot, navigate, click]`;

function reason(text: string): string {
  return Result.match(readBotsFile(text), {
    onSuccess: () => "valid",
    onFailure: (why) => why,
  });
}

describe("readBotsFile", () => {
  it("reads the bots.yaml the server starts with: Assistant has every tool, Researcher reads the web", () => {
    const shipped = readFileSync(new URL("../../../../../bots.yaml", import.meta.url), "utf8");
    const bots = Result.getOrThrow(readBotsFile(shipped));
    const tools = (id: string) => bots.find((bot) => bot.id === id)?.tools;

    expect(bots[0].id).toBe("assistant");
    expect(tools("assistant")).toEqual(new Set(ToolName.literals));
    expect(tools("researcher")).toEqual(new Set(["snapshot", "navigate", "click"]));
  });

  it("reads each Bot with its grants, in the order the file lists them", () => {
    const bots = Result.getOrThrow(
      readBotsFile(`bots:
  - id: assistant
    name: Assistant
    pinned: true
    instructions: You are Assistant.
    tools: [run]${researcher}`),
    );

    expect(bots.map((bot) => bot.id)).toEqual(["assistant", "researcher"]);
    expect(bots[0]).toMatchObject({ name: "Assistant", pinned: true, tools: new Set(["run"]) });
    expect(bots[1]).toMatchObject({
      pinned: false,
      tools: new Set(["snapshot", "navigate", "click"]),
    });
    expect(bots[1]?.group).toEqual(Option.some("research"));
  });

  it.each([
    ["is not YAML", "bots: [", "Flow sequence"],
    ["is empty", "", "the file is empty"],
    ["holds only comments", "# no Bots yet\n", "the file is empty"],
    ["lists no Bot", "bots: []", 'the file lists no Bot\n  at ["bots"]'],
    [
      "expands an alias past what the parser allows",
      `a: &a [x, x, x, x, x, x, x, x, x, x]
b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]
c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]
d: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]
e: [*d, *d, *d, *d, *d, *d, *d, *d, *d, *d]`,
      "Excessive alias count",
    ],
    ["has no bots key", "assistant: {}", 'Expected no excess property\n  at ["assistant"]'],
    [
      "names a tool that does not exist",
      `bots:${researcher.replace("click", "rm_rf")}`,
      'Expected "navigate" | "snapshot"',
    ],
    ["misses a Bot's grants", `bots:${researcher.replace(/\n.*tools.*$/u, "")}`, '["tools"]'],
    ["misspells a key", `bots:${researcher.replace("group", "grop")}`, '["grop"]'],
    [
      "gives an id that is not a slug",
      `bots:${researcher.replace("id: researcher", "id: Re Search")}`,
      '["bots"][0]["id"]',
    ],
    [
      "gives an id longer than 64 characters",
      `bots:${researcher.replace("id: researcher", `id: ${"r".repeat(65)}`)}`,
      '["bots"][0]["id"]',
    ],
    ["gives two Bots one id", `bots:${researcher}${researcher}`, "researcher names two Bots"],
    [
      "pins a Bot it also puts in a group",
      `bots:${researcher.replace("group: research", "group: research\n    pinned: true")}`,
      'a pinned Bot shows in the grid, so it takes no group\n  at ["bots"][0]["group"]',
    ],
  ])("refuses a file that %s", (_why, text, expected) => {
    expect(reason(text)).toContain(expected);
  });

  it("names every problem in the file, not just the first", () => {
    const why = reason(`bots:${researcher.replace("click", "rm_rf").replace("group", "grop")}`);

    expect(why).toContain('["grop"]');
    expect(why).toContain('["tools"][2]');
  });
});
