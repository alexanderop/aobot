import { Array, DateTime, Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

const decodeHeld = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ since: Schema.DateTimeUtcFromString })),
);

/**
Whether a person holds the computer, in the database, so a restart never hands control back to the Bots by
itself. No row means the Bots hold it.
*/
export const controlStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /** Since when a person holds the computer, if they do. */
  const held = Effect.gen(function* () {
    const rows = yield* sql`SELECT since FROM computer_control`.pipe(Effect.flatMap(decodeHeld));

    return Option.map(Array.head(rows), (row) => row.since);
  }).pipe(Effect.withSpan("ControlStore.held"));

  const hold = Effect.fn("ControlStore.hold")(function* (since: DateTime.Utc) {
    yield* sql`
      INSERT INTO computer_control (id, since) VALUES (1, ${DateTime.formatIso(since)})
      ON CONFLICT (id) DO UPDATE SET since = excluded.since
    `;
  });

  const release = Effect.fn("ControlStore.release")(function* () {
    yield* sql`DELETE FROM computer_control`;
  });

  return { held, hold, release };
});
