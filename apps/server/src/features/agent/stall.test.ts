import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { Stalled } from "./agent-runtime.ts";
import { stallWhenSilent } from "./stall.ts";

const limits = { limit: Duration.seconds(10), busyLimit: Duration.seconds(60) };

/** An event `after` from now, then the end of the stream. */
const eventAfter = (after: Duration.Input) =>
  Stream.fromEffect(Effect.as(Effect.sleep(after), "event"));

/** `events` collected with the clock moved one second at a time up to `seconds`. */
const collectOver = <E>(events: Stream.Stream<string, E>, seconds: number) =>
  Effect.gen(function* () {
    const fiber = yield* Stream.runCollect(events).pipe(Effect.result, Effect.forkChild);

    for (let second = 0; second < seconds; second++) yield* TestClock.adjust("1 second");

    return yield* Fiber.join(fiber);
  });

describe("stallWhenSilent", () => {
  it.effect("fails as stalled once the limit passes with nothing while no call runs", () =>
    Effect.gen(function* () {
      const ended = yield* collectOver(
        stallWhenSilent(eventAfter("30 seconds"), Effect.succeed(false), limits),
        30,
      );

      expect(ended).toEqual(
        expect.objectContaining({ failure: new Stalled({ waitedMs: 10_000 }) }),
      );
    }),
  );

  it.effect("waits past the limit while a call runs", () =>
    Effect.gen(function* () {
      const ended = yield* collectOver(
        stallWhenSilent(eventAfter("50 seconds"), Effect.succeed(true), limits),
        50,
      );

      expect(ended).toEqual(expect.objectContaining({ success: ["event"] }));
    }),
  );

  it.effect("fails as stalled at the busy limit when a call never ends", () =>
    Effect.gen(function* () {
      const ended = yield* collectOver(
        stallWhenSilent(Stream.never, Effect.succeed(true), limits),
        60,
      );

      expect(ended).toEqual(
        expect.objectContaining({ failure: new Stalled({ waitedMs: 60_000 }) }),
      );
    }),
  );
});
