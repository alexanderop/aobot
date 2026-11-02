import { Duration, Effect, Stream } from "effect";
import { Stalled } from "./agent-runtime.ts";

/**
`events`, failing with {@link Stalled} once `limit` passes with nothing from it while `busy` says no tool
call runs. A tool can run longer than the model may stay silent, such as `request_secret` waiting for a
person, and its end is the next thing `events` carries, so only the model's own silence counts. Past
`busyLimit` of silence it fails all the same, busy or not: an `acp` CLI says when a call starts and ends,
and one that never says it ended would otherwise hold the turn forever.
*/
export function stallWhenSilent<A, E, R>(
  events: Stream.Stream<A, E, R>,
  busy: Effect.Effect<boolean>,
  limits: { readonly limit: Duration.Duration; readonly busyLimit: Duration.Duration },
): Stream.Stream<A, E | Stalled, R> {
  const quiet = Effect.sleep(limits.limit).pipe(
    Effect.andThen(busy),
    Effect.repeat({ while: (running) => running }),
    Effect.as(limits.limit),
  );

  const silence = Effect.raceFirst(
    quiet,
    Effect.as(Effect.sleep(limits.busyLimit), limits.busyLimit),
  ).pipe(
    Effect.flatMap((waited) => Effect.fail(new Stalled({ waitedMs: Duration.toMillis(waited) }))),
  );

  return Stream.transformPull(events, (pull) => Effect.succeed(Effect.raceFirst(pull, silence)));
}
