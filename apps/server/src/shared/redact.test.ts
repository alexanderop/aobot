import { describe, expect, it } from "vite-plus/test";
import { redact } from "./redact.ts";

describe("redact", () => {
  it("keeps the length of what a Bot typed and nothing of its value", () => {
    expect(redact("cat /etc/passwd")).toBe("[15 chars]");
    expect(redact("")).toBe("[0 chars]");
  });
});
