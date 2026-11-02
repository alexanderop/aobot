import { Effect, Layer, Option, Schema, Tracer } from "effect";
import { isSensitiveKey, redact, redactField } from "./redact.ts";

const decodeJson = Schema.decodeUnknownOption(Schema.Json);

/**
Wraps the tracer in the context so that every span attribute goes through {@link redactField} before any
exporter sees it, whoever wrote it: our code or a library. A key that may hold a secret or a tool's input
or output keeps only the value's length, such as the `parameters` `effect/ai` writes each tool call's
input under, and every address keeps no query values, fragment or userinfo. Provide it above the tracer
that exports.
*/
export const spanAttributesRedacted = Layer.effect(
  Tracer.Tracer,
  Effect.map(Effect.tracer, (tracer) =>
    Tracer.make({
      context: tracer.context,
      span(options) {
        const span = tracer.span(options);
        const attribute = span.attribute.bind(span);

        // Only this span's own method is replaced, so the exporter still gets the span it made.
        span.attribute = (key, value) =>
          attribute(
            key,
            Option.match(decodeJson(value), {
              onNone: () => (isSensitiveKey(key) ? redact(String(value)) : value),
              onSome: (json) => redactField(key, json),
            }),
          );

        return span;
      },
    }),
  ),
);
