import { describe, expect, it } from "@effect/vitest";
import { Option, Redacted } from "effect";
import { modelCheckFinding } from "./model-check.ts";
import type { ModelSettings } from "./model-providers.ts";

function settings(provider: ModelSettings["provider"]): ModelSettings {
  return { provider, name: "claude-x", apiKey: Redacted.make("key"), baseUrl: Option.none() };
}

describe("modelCheckFinding", () => {
  it("is quiet when the key can use the model", () => {
    expect(modelCheckFinding(settings("anthropic"), 200).level).toBe("Info");
  });

  it("says to replace a key the provider refuses", () => {
    const finding = modelCheckFinding(settings("openai"), 401);

    expect(finding.level).toBe("Warn");
    expect(finding.message).toContain("Set MODEL_API_KEY");
  });

  it("warns about a model the key cannot use, except where a lookup may not exist", () => {
    expect(modelCheckFinding(settings("anthropic"), 404).message).toContain("MODEL_NAME");
    expect(modelCheckFinding(settings("openai-compat"), 404).level).toBe("Info");
  });
});
