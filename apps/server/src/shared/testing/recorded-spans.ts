import { Layer, Tracer } from "effect";

/** A tracer that keeps every span it makes in `spans`, for a test to read what was recorded. */
export function recordedSpans() {
  const spans: Array<Tracer.NativeSpan> = [];

  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);

      return span;
    },
  });

  return { spans, layer: Layer.succeed(Tracer.Tracer, tracer) };
}
