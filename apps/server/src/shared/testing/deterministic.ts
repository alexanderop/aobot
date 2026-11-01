import { Effect, Random } from "effect";
import { TestClock } from "effect/testing";

/**
Run `effect` on a test clock and a seeded `Random`, so time only moves when the test says so and every
id from `randomUuid` is the same on every run. `it.effect` already brings the test clock; this adds the
seed, and gives both to code outside `it.effect`, such as a fixture builder.
*/
export function deterministic<A, E, R>(effect: Effect.Effect<A, E, R>, seed = 0x1234_5678) {
  return effect.pipe(Effect.provide(TestClock.layer()), Random.withSeed(seed));
}
