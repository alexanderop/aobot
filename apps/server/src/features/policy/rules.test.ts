import { describe, expect, it } from "vite-plus/test";
import { blankFacts, type Facts } from "./facts.ts";
import { judge, RuleName, Verdict } from "./rules.ts";
import { rulesFrom } from "./testing/test-policy.ts";

/** The facts of `run`ning `command` as Assistant, with every other field neutral. */
function running(command: string): Facts {
  return {
    ...blankFacts,
    tool: { name: "run" },
    bot: { id: "assistant" },
    actor: { id: "single-user" },
    computer: { kind: "cloud" },
    command,
  };
}

/** A rule that passes the check on blank facts, then fails on any command but a number. */
const numberOnly = 'command == "" || int(command) > 0';

const { Allowed, Denied, DenyRuleFailed, NoneAllowed } = Verdict.cases;

/** The facts of a browser action on an element of a page on shop.example, pressing `key` when it is `press`. */
function onTheShop(tool: "click" | "press", role: string, name: string, key = ""): Facts {
  return {
    ...running(""),
    tool: { name: tool },
    page: { host: "shop.example" },
    element: { role, name },
    key,
  };
}

/** A deny rule named `rule` failed, with an error that says `why`. */
function failedWith(rule: string, why: string) {
  return {
    ...DenyRuleFailed.make({ rule: RuleName.make(rule), error: why }),
    error: expect.stringContaining(why),
  };
}

/** The allow rule named `rule` failed on the way, with an error that says `why`. */
function brokenWith(rule: string, why: string) {
  return { rule: RuleName.make(rule), error: expect.stringContaining(why) };
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
  - name: number-only
    when: ${numberOnly}
  - name: no-rm-rf
    when: command.contains("rm -rf")${allowAll}`,
      "ls",
      failedWith("number-only", "int()"),
    ],
    [
      "a deny rule that fails on this action's value refuses",
      `deny:
  - name: third-argument
    when: command == "" || command.split(" ")[2] == "-rf"${allowAll}`,
      "ls -la",
      failedWith("third-argument", "index out of bounds"),
    ],
    [
      "an allow rule that fails allows nothing, and a later one still can",
      `deny: []
allow:
  - name: number-only
    when: ${numberOnly}
  - name: granted-tools
    when: "true"`,
      "ls",
      {
        ...Allowed.make({ rule: RuleName.make("granted-tools"), broken: [] }),
        broken: [brokenWith("number-only", "int()")],
      },
    ],
    [
      "an allow rule that fails, with none after it, leaves the action refused",
      `deny: []
allow:
  - name: number-only
    when: ${numberOnly}`,
      "ls",
      { ...NoneAllowed.make({ broken: [] }), broken: [brokenWith("number-only", "int()")] },
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
});

describe("a rule against submitting the shop's form", () => {
  const rules = rulesFrom(`deny:
  - name: no-submit
    when: tool.name in ["click", "press"] && element.name == "Submit"
  - name: no-enter-on-the-shop
    when: tool.name == "press" && key == "Enter" && page.host == "shop.example"
allow:
  - name: granted-tools
    when: "true"`);

  it.each([
    [
      "refuses clicking Submit",
      onTheShop("click", "button", "Submit"),
      Denied.make({ rule: RuleName.make("no-submit") }),
    ],
    [
      "refuses pressing Enter in the form's field, which would submit it as well",
      onTheShop("press", "textbox", "Name", "Enter"),
      Denied.make({ rule: RuleName.make("no-enter-on-the-shop") }),
    ],
    [
      "refuses pressing Space on Submit, which clicks it",
      onTheShop("press", "button", "Submit", "Space"),
      Denied.make({ rule: RuleName.make("no-submit") }),
    ],
    [
      "refuses pressing Enter on Submit on any host, not only the shop",
      { ...onTheShop("press", "button", "Submit", "Enter"), page: { host: "elsewhere.example" } },
      Denied.make({ rule: RuleName.make("no-submit") }),
    ],
    [
      "allows pressing Enter in a field on another host",
      { ...onTheShop("press", "textbox", "Name", "Enter"), page: { host: "elsewhere.example" } },
      Allowed.make({ rule: RuleName.make("granted-tools"), broken: [] }),
    ],
    [
      "allows clicking Cancel",
      onTheShop("click", "button", "Cancel"),
      Allowed.make({ rule: RuleName.make("granted-tools"), broken: [] }),
    ],
    [
      "allows pressing Tab in the field",
      onTheShop("press", "textbox", "Name", "Tab"),
      Allowed.make({ rule: RuleName.make("granted-tools"), broken: [] }),
    ],
  ])("%s", (_case, facts, verdict) => {
    expect(judge(rules, facts)).toEqual(verdict);
  });
});
