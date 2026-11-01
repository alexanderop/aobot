import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { randomUuid } from "./random-id.ts";
import { deterministic } from "./testing/deterministic.ts";

const twoIds = Effect.all([randomUuid, randomUuid]);

describe("randomUuid", () => {
  it.effect("is a version 4 UUID", () =>
    Effect.gen(function* () {
      expect(yield* randomUuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
    }),
  );

  it.effect("gives the same ids for the same seed, and different ids within one run", () =>
    Effect.gen(function* () {
      const first = yield* deterministic(twoIds);
      const again = yield* deterministic(twoIds);
      const otherSeed = yield* deterministic(twoIds, 7);

      expect(again).toEqual(first);
      expect(first[0]).not.toBe(first[1]);
      expect(otherSeed).not.toEqual(first);
    }),
  );
});
