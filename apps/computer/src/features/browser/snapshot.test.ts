import { snapshotLimit } from "@aobot/domain";
import { describe, expect, it } from "vite-plus/test";
import { capSnapshot } from "./snapshot.ts";

describe("capSnapshot", () => {
  it("keeps a snapshot within the limit as it is", () => {
    const text = '- heading "Example Domain" [level=1] [ref=e3]';
    expect(capSnapshot(text, snapshotLimit)).toEqual({ snapshot: text, truncated: false });
  });

  it("keeps a snapshot of exactly the limit", () => {
    const text = "x".repeat(snapshotLimit);
    expect(capSnapshot(text, snapshotLimit)).toEqual({ snapshot: text, truncated: false });
  });

  it("cuts a longer snapshot to the limit and marks it truncated", () => {
    const capped = capSnapshot("x".repeat(snapshotLimit + 500), snapshotLimit);
    expect(capped.snapshot).toHaveLength(snapshotLimit);
    expect(capped.truncated).toBe(true);
  });

  it("stops before an emoji the cut would split", () => {
    const text = `${"x".repeat(snapshotLimit - 1)}😀 and more`;
    const capped = capSnapshot(text, snapshotLimit);
    expect(capped.snapshot).toBe("x".repeat(snapshotLimit - 1));
    expect(capped.truncated).toBe(true);
    expect(capped.snapshot).not.toMatch(/[\uD800-\uDBFF]$/u);
  });

  it("keeps an emoji that ends exactly at the limit", () => {
    const text = `${"x".repeat(snapshotLimit - 2)}😀 and more`;
    expect(capSnapshot(text, snapshotLimit).snapshot.endsWith("😀")).toBe(true);
  });
});
