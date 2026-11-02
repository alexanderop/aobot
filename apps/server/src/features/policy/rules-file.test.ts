import { readFileSync } from "node:fs";
import { Result } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { readRulesFile } from "./rules-file.ts";

const rmRf = `
  - name: no-rm-rf
    when: tool.name == "run" && command.contains("rm -rf")`;

const granted = `
  - name: granted-tools
    when: "true"`;

function reason(text: string): string {
  return Result.match(readRulesFile(text), {
    onSuccess: () => "valid",
    onFailure: (why) => why,
  });
}

describe("readRulesFile", () => {
  it("reads the rules.yaml the server starts with: no rm -rf, then whatever a Bot was granted", () => {
    const shipped = readFileSync(new URL("../../../../../rules.yaml", import.meta.url), "utf8");
    const rules = Result.getOrThrow(readRulesFile(shipped));

    expect(rules.deny.map((rule) => rule.name)).toEqual(["no-rm-rf"]);
    expect(rules.allow.map((rule) => rule.name)).toEqual(["granted-tools"]);
  });

  it("reads each list's rules by name, in the order the file gives them", () => {
    const rules = Result.getOrThrow(readRulesFile(`deny:${rmRf}\nallow:${granted}`));

    expect(rules.deny.map((rule) => rule.name)).toEqual(["no-rm-rf"]);
    expect(rules.allow.map((rule) => rule.name)).toEqual(["granted-tools"]);
  });

  it("reads empty lists as a policy that allows nothing", () => {
    const rules = Result.getOrThrow(readRulesFile("deny: []\nallow: []"));

    expect(rules).toEqual({ deny: [], allow: [] });
  });

  it.each([
    'computer.kind.substring(0, 3) == "clo"',
    'actor.id.substring(0, 6) == "single"',
    'bot.id.substring(0, 1) == "r"',
  ])("reads a rule that cuts a fact every action has: %s", (when) => {
    expect(reason(`deny: []\nallow:${granted.replace('"true"', `'${when}'`)}`)).toBe("valid");
  });

  it.each([
    ["is not YAML", "deny: [", "Flow sequence"],
    ["is empty", "", "the file is empty"],
    ["holds only comments", "# no rules yet\n", "the file is empty"],
    ["has no allow list", `deny:${rmRf}`, '["allow"]'],
    ["has no deny list", `allow:${granted}`, '["deny"]'],
    ["misspells a list", `deny: []\nalow:${granted}`, 'Expected no excess property\n  at ["alow"]'],
    ["misspells a key of a rule", `deny: []\nallow:${granted.replace("when", "wen")}`, '["wen"]'],
    [
      "misses a rule's expression",
      `deny: []\nallow:\n  - name: granted-tools`,
      '["allow"][0]["when"]',
    ],
    [
      "gives a name that is not a slug",
      `deny:${rmRf.replace("no-rm-rf", "No RM")}\nallow: []`,
      '["deny"][0]["name"]',
    ],
    [
      "gives two rules one name, across both lists",
      `deny:${rmRf}\nallow:${granted.replace("granted-tools", "no-rm-rf")}`,
      'no-rm-rf names two rules\n  at ["allow"][0]["name"]',
    ],
    [
      "gives a rule an expression that does not parse",
      `deny: []\nallow:${granted.replace('"true"', "tool.name ==")}`,
      'Unexpected token: EOF\n  at ["allow"][0]["when"]',
    ],
    [
      "names a field the facts do not have",
      `deny:${rmRf.replace("tool.name", "tool.nam")}\nallow: []`,
      'No such key: nam\n  at ["deny"][0]["when"]',
    ],
    [
      "names a variable the facts do not have",
      `deny: []\nallow:${granted.replace('"true"', 'url == "x"')}`,
      "Unknown variable: url",
    ],
    [
      "gives a rule that answers a string",
      `deny: []\nallow:${granted.replace('"true"', `'"Submit"'`)}`,
      "it answers string, not true or false",
    ],
    [
      "gives a rule whose answer is known only once it runs",
      `deny: []\nallow:${granted.replace('"true"', "dyn(command)")}`,
      "it answers dyn, not true or false",
    ],
    [
      "calls matches, whose regular expression could stall the server",
      `deny:${rmRf.replace('command.contains("rm -rf")', 'command.matches("^(a+)+$")')}\nallow: []`,
      'matches is not allowed, since a regular expression can stall the server; use contains, startsWith, endsWith or lowerAscii()\n  at ["deny"][0]["when"]',
    ],
    [
      "calls matches inside a macro",
      `deny: []\nallow:${granted.replace('"true"', `'[command].exists(c, c.matches("x"))'`)}`,
      "matches is not allowed",
    ],
    [
      "gives a rule that reads a number out of text that holds none",
      `deny: []\nallow:${granted.replace('"true"', "'int(\"ten\") > 3'")}`,
      'it fails when page.host, element, key, command and file are "": int() type error',
    ],
    [
      "gives a rule that divides by zero",
      `deny: []\nallow:${granted.replace('"true"', '"1/0 == 1"')}`,
      'it fails when page.host, element, key, command and file are "": division by zero',
    ],
    [
      "gives a rule that indexes past the end of a list",
      `deny: []\nallow:${granted.replace('"true"', '\'command.split(" ")[1] == "-rf"\'')}`,
      "index out of bounds",
    ],
    [
      "gives a rule that cuts a string past its end",
      `deny: []\nallow:${granted.replace('"true"', 'file.name.substring(1) == "env"')}`,
      "start index out of range",
    ],
  ])("refuses a file that %s", (_case, text, why) => {
    expect(reason(text)).toContain(why);
  });

  it("names every problem in the file, not just the first", () => {
    const why = reason(
      `deny:${rmRf.replace("tool.name", "tool.nam")}\nallow:${granted.replace('"true"', '"yes"')}`,
    );

    expect(why).toContain('["deny"][0]["when"]');
    expect(why).toContain('["allow"][0]["when"]');
  });
});
