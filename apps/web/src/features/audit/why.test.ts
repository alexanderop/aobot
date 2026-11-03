import type { AuditRow } from "@aobot/domain";
import { Option, type Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { whyOf } from "./why.ts";

function rowWith(detail: Schema.JsonObject): AuditRow {
  return {
    id: "row-1",
    createdAt: "2026-11-02T10:00:00.000Z",
    initiatorKind: "person",
    person: "single-user",
    bot: Option.some("assistant"),
    decision: "answered",
    action: "approval.answered",
    detail,
    traceId: Option.none(),
    traceUrl: Option.none(),
  };
}

describe("whyOf", () => {
  it("reads the rule and the reason a refusal names", () => {
    expect(whyOf(rowWith({ rule: "no-rm-rf", reason: "denied by rule" }))).toEqual({
      decidedBy: Option.some("no-rm-rf"),
      reason: Option.some("denied by rule"),
    });
  });

  it.each([
    ["names no rule", { name: "Change password", safety: "credentials" }],
    ["names the ask rule it was asked under", { rule: "ask-first", safety: "security" }],
  ])(
    "reads an action handed to the person that %s as decided by the safety list",
    (_case, detail) => {
      expect(whyOf(rowWith(detail)).decidedBy).toEqual(Option.some(`safety:${detail.safety}`));
    },
  );

  it.each([
    [{ answer: "yes", by: "person" }, "Yes (person)"],
    [{ answer: "no", by: "time limit" }, "No (time limit)"],
    [{ answer: "no", by: "the server stopped" }, "No (the server stopped)"],
  ])("reads the person's answer %j as %j", (detail, reason) => {
    expect(whyOf(rowWith({ approval: "approval-1", ...detail }))).toEqual({
      decidedBy: Option.none(),
      reason: Option.some(reason),
    });
  });

  it.each([
    ["neither yes nor no", { answer: "maybe", by: "person" }],
    ["by no one the server names", { answer: "no", by: "someone" }],
  ])("reads an answer %s as no reason", (_case, detail) => {
    expect(whyOf(rowWith(detail)).reason).toEqual(Option.none());
  });
});
