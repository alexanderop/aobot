import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { capText, ToolTimedOut, toolResult, toolResultLimit } from "./tool-result.ts";

describe("capText", () => {
  it("keeps a result within the limit as it is", () => {
    const text = "a".repeat(toolResultLimit);

    expect(capText(text)).toBe(text);
  });

  it("cuts a 50,000-character result to the limit and says how much it cut", () => {
    const capped = capText("a".repeat(50_000));

    expect(capped).toBe(`${"a".repeat(20_000)}\n[truncated: 30000 characters]`);
  });

  it("never splits a character made of two code units", () => {
    const capped = capText(`${"a".repeat(9)}😀b`, 10);

    expect(capped).toBe(`${"a".repeat(9)}\n[truncated: 3 characters]`);
  });
});

describe("toolResult", () => {
  const seam = toolResult({ source: "web page", timeout: Duration.seconds(5) });

  it.effect("hands the model the result marked untrusted and capped", () =>
    Effect.gen(function* () {
      const result = yield* seam(Effect.succeed("x".repeat(50_000)));

      expect(result.startsWith("CRITICAL: The following web page content")).toBe(true);
      expect(result).toContain("\n[truncated: 30000 characters]\n</untrusted_data>");
    }),
  );

  it.effect("stops a tool that runs past its limit", () =>
    Effect.gen(function* () {
      const running = yield* Effect.forkChild(Effect.flip(seam(Effect.never)));
      yield* TestClock.adjust(Duration.seconds(5));

      expect(yield* Fiber.join(running)).toEqual(new ToolTimedOut({ timeoutMs: 5000 }));
    }),
  );
});
