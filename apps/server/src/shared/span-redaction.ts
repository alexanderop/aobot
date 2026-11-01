import { Effect, Layer, Tracer } from "effect";
import { redact } from "./redact.ts";

/**
`effect/ai` writes each tool call's input onto the current span as `parameters`, and a tool input can hold
what a Bot typed. This wraps the tracer in the context so that attribute keeps only its length, before any
exporter sees it. Provide it above the tracer that exports.
*/
export const toolInputsRedacted = Layer.effect(
  Tracer.Tracer,
  Effect.map(Effect.tracer, (tracer) =>
    Tracer.make({
      context: tracer.context,
      span(options) {
        const span = tracer.span(options);
        const attribute = span.attribute.bind(span);

        // Only this span's own method is replaced, so the exporter still gets the span it made.
        span.attribute = (key, value) =>
          attribute(key, key === "parameters" ? redact(JSON.stringify(value) ?? "") : value);

        return span;
      },
    }),
  ),
);
