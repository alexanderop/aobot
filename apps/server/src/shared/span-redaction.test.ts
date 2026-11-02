import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { spanAttributesRedacted } from "./span-redaction.ts";
import { recordedSpans } from "./testing/recorded-spans.ts";

describe("spanAttributesRedacted", () => {
  it.effect("keeps only the length under a key that may hold a secret, in any spelling", () =>
    Effect.gen(function* () {
      const recorder = recordedSpans();

      yield* Effect.annotateCurrentSpan({
        parameters: { ref: "e1", text: "hunter2-secret" },
        toolResult: "the page",
        tool_result: "the page",
        "http.request.header.authorization": "Bearer hunter2",
        "gateway.action": "type",
        "gen_ai.usage.input_tokens": 120,
      }).pipe(
        Effect.withSpan("Gateway.act", { attributes: { password: "hunter2" } }),
        Effect.provide(spanAttributesRedacted.pipe(Layer.provide(recorder.layer))),
      );

      const attributes = Object.fromEntries(recorder.spans[0]?.attributes ?? []);
      expect(attributes).toEqual({
        password: "[7 chars]",
        parameters: "[36 chars]",
        toolResult: "[8 chars]",
        tool_result: "[8 chars]",
        "http.request.header.authorization": "[14 chars]",
        "gateway.action": "type",
        "gen_ai.usage.input_tokens": 120,
      });
    }),
  );

  it.effect("keeps an address without its query values, fragment or userinfo", () =>
    Effect.gen(function* () {
      const recorder = recordedSpans();

      yield* Effect.annotateCurrentSpan("url.full", "https://ada:pw@api.example/v1?key=abc#x").pipe(
        Effect.withSpan("http.client POST"),
        Effect.provide(spanAttributesRedacted.pipe(Layer.provide(recorder.layer))),
      );

      expect(recorder.spans[0]?.attributes.get("url.full")).toBe(
        "https://[6 chars]@api.example/v1?key=[3 chars]#[1 chars]",
      );
    }),
  );
});
