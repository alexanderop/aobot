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
      rule: Option.some("no-rm-rf"),
      reason: Option.some("denied by rule"),
    });
  });

  it.each([
    [{ answer: "yes", by: "person" }, "Yes (person)"],
    [{ answer: "no", by: "time limit" }, "No (time limit)"],
  ])("reads the person's answer %j as %j", (detail, reason) => {
    expect(whyOf(rowWith({ approval: "approval-1", ...detail }))).toEqual({
      rule: Option.none(),
      reason: Option.some(reason),
    });
  });

  it("reads an answer that is neither yes nor no as no reason", () => {
    expect(whyOf(rowWith({ answer: "maybe", by: "person" })).reason).toEqual(Option.none());
  });
});
