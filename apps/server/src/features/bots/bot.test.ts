import { ToolName } from "@aobot/domain";
import { describe, expect, it } from "vite-plus/test";
import { isGranted, turnInstructions } from "./bot.ts";
import { assistant, researcher } from "./testing/test-bots.ts";
import { botToolkit } from "./toolkit.ts";

const nobody = { ...researcher, tools: new Set<ToolName>() };

describe("isGranted", () => {
  it.each([
    ["Researcher", researcher, "navigate", true],
    ["Researcher", researcher, "click", true],
    ["Researcher", researcher, "run", false],
    ["Researcher", researcher, "write_file", false],
    ["Assistant", assistant, "run", true],
    ["a Bot granted nothing", nobody, "snapshot", false],
  ] as const)("lets %s use %s: %s", (_who, bot, tool, allowed) => {
    expect(isGranted(bot, tool)).toBe(allowed);
  });
});

describe("turnInstructions", () => {
  it("names only the tools the Bot was granted, and says the others are refused", () => {
    const instructions = turnInstructions(researcher);

    expect(instructions).toContain("You are Researcher.");
    expect(instructions).toContain("these tools on it: navigate, snapshot, click.");
    expect(instructions).toContain("Any other tool is refused");
    expect(instructions).not.toMatch(/\brun\b|read_file|write_file|list_files/u);
    expect(instructions).toContain("untrusted_data");
  });

  it("tells a Bot granted nothing that it has no tools", () => {
    expect(turnInstructions(nobody)).toContain("You have no tools");
  });
});

describe("botToolkit", () => {
  it("offers exactly the tools a grant can name", () => {
    expect(Object.keys(botToolkit.tools).sort()).toEqual([...ToolName.literals].sort());
  });
});
