import { BotId } from "@aobot/domain";
import { describe, expect, it } from "vite-plus/test";
import type { Facts } from "./facts.ts";
import { judge, RuleName, Verdict } from "./rules.ts";
import { rulesFrom } from "./testing/test-policy.ts";

/** The facts of `run`ning `command` as Assistant, with every other field neutral. */
function running(command: string): Facts {
  return {
    tool: { name: "run" },
    bot: { id: BotId.make("assistant") },
    actor: { id: "single-user" },
    computer: { kind: "cloud" },
    page: { host: "" },
    element: { role: "", name: "" },
    key: "",
    command,
    file: { path: "", name: "", extension: "" },
  };
}

const { Allowed, Denied, Broke, NoneAllowed } = Verdict.cases;

/** A deny rule named `rule` failed, with an error that says `why`. */
function brokeWith(rule: string, why: string) {
  return {
    ...Broke.make({ rule: RuleName.make(rule), error: why }),
    error: expect.stringContaining(why),
  };
}

const allowAll = `
allow:
  - name: granted-tools
    when: "true"`;

describe("judge", () => {
  it.each([
    [
      "a deny rule wins over an allow rule",
      `deny:
  - name: no-rm-rf
    when: tool.name == "run" && command.contains("rm -rf")${allowAll}`,
      "rm -rf /tmp/x",
      Denied.make({ rule: RuleName.make("no-rm-rf") }),
    ],
    [
      "an action no deny rule holds for is allowed by the first allow rule that holds",
      `deny:
  - name: no-rm-rf
    when: command.contains("rm -rf")
allow:
  - name: only-ls
    when: command == "ls"
  - name: granted-tools
    when: "true"`,
      "ls",
      Allowed.make({ rule: RuleName.make("only-ls"), broken: [] }),
    ],
    [
      "the first deny rule in the file refuses, when two hold",
      `deny:
  - name: no-rm
    when: command.startsWith("rm")
  - name: no-rm-rf
    when: command.contains("rm -rf")${allowAll}`,
      "rm -rf /tmp/x",
      Denied.make({ rule: RuleName.make("no-rm") }),
    ],
    [
      "a deny rule that fails refuses, though no rule after it would",
      `deny:
  - name: bad-pattern
    when: command.matches("[")
  - name: no-rm-rf
    when: command.contains("rm -rf")${allowAll}`,
      "ls",
      brokeWith("bad-pattern", "Invalid regular expression"),
    ],
    [
      "a deny rule that fails on this action's value refuses",
      `deny:
  - name: count-arguments
    when: int(command) > 3${allowAll}`,
      "ls -la",
      brokeWith("count-arguments", "int()"),
    ],
    [
      "an allow rule that fails allows nothing, and a later one still can",
      `deny: []
allow:
  - name: bad-pattern
    when: command.matches("[")
  - name: granted-tools
    when: "true"`,
      "ls",
      Allowed.make({
        rule: RuleName.make("granted-tools"),
        broken: [RuleName.make("bad-pattern")],
      }),
    ],
    [
      "an allow rule that fails, with none after it, leaves the action refused",
      `deny: []
allow:
  - name: bad-pattern
    when: command.matches("[")`,
      "ls",
      NoneAllowed.make({ broken: [RuleName.make("bad-pattern")] }),
    ],
    [
      "an action no allow rule holds for is refused",
      `deny: []
allow:
  - name: only-ls
    when: command == "ls"`,
      "pwd",
      NoneAllowed.make({ broken: [] }),
    ],
    [
      "an empty policy refuses everything",
      "deny: []\nallow: []",
      "ls",
      NoneAllowed.make({ broken: [] }),
    ],
  ])("%s", (_case, file, command, verdict) => {
    expect(judge(rulesFrom(file), running(command))).toEqual(verdict);
  });

  it.each([
    "tool.name",
    "bot.id",
    "actor.id",
    "computer.kind",
    "page.host",
    "element.role",
    "element.name",
    "key",
    "command",
    "file.path",
    "file.name",
    "file.extension",
  ])(
    "binds %s on an action that has none, so a rule naming it answers and never fails",
    (field) => {
      const rules = rulesFrom(`deny:
  - name: names-the-field
    when: ${field} == "Submit"${allowAll}`);

      expect(judge(rules, running("ls"))).toEqual(
        Allowed.make({ rule: RuleName.make("granted-tools"), broken: [] }),
      );
    },
  );
});
