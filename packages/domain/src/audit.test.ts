import { describe, expect, it } from "vite-plus/test";
import { actionLabel, AuditAction, AuditDecision, decisionLabel, unknownLabel } from "./audit.ts";

describe("decisionLabel", () => {
  it("names every decision, each its own way", () => {
    const labels = AuditDecision.literals.map(decisionLabel);

    expect(labels).not.toContain(unknownLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("reads a refusal as Refused and an allowed call as Allowed", () => {
    expect(decisionLabel("deny")).toBe("Refused");
    expect(decisionLabel("allow")).toBe("Allowed");
  });

  it.each(["approved", "", "Allow", "constructor"])("reads %j as Unknown, never Allowed", (raw) => {
    expect(decisionLabel(raw)).toBe("Unknown");
  });
});

describe("actionLabel", () => {
  it("names every action, each its own way", () => {
    const labels = AuditAction.literals.map(actionLabel);

    expect(labels).not.toContain(unknownLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it.each(["approval.granted", "request_secret", "", "toString"])("reads %j as Unknown", (raw) => {
    expect(actionLabel(raw)).toBe("Unknown");
  });
});
