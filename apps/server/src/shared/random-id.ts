import { Effect, Random } from "effect";

const hex = (byte: number) => byte.toString(16).padStart(2, "0");

/**
A version 4 UUID drawn from Effect's `Random`, so a test that seeds it (see `testing/deterministic.ts`)
gets the same ids on every run. `crypto.randomUUID()` cannot be seeded.
*/
export const randomUuid: Effect.Effect<string> = Effect.gen(function* () {
  const bytes = yield* Effect.forEach(Array.from({ length: 16 }), () =>
    Random.nextIntBetween(0, 255),
  );

  // SAFETY: `bytes` has 16 entries, built above. Version 4 and the RFC 4122 variant bits.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  // SAFETY: as above.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const text = bytes.map(hex).join("");

  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
});
