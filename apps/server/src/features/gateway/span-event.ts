import { Clock, Effect } from "effect";

/** Adds the event `name` to the current span, if there is one, at the Clock's time. */
export const spanEvent = (name: string, attributes: Readonly<Record<string, number>> = {}) =>
  Effect.currentSpan.pipe(
    Effect.flatMap((span) =>
      Effect.map(Clock.currentTimeNanos, (now) => span.event(name, now, attributes)),
    ),
    Effect.ignore,
  );
