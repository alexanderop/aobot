import { BotId, type PageRead } from "@aobot/domain";
import { Array, Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

const decodeSnapshots = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ snapshot: Schema.String, url: Schema.String, read_by: BotId })),
);

/**
The latest snapshot of the page on the one computer every Bot shares, the address it was read at, and the
Bot whose action read it, so a ref resolves only for the Bot that saw the page it names. In the database
rather than in memory, so whichever replica handles the next call resolves it the same way.
*/
export const snapshotStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const latest = Effect.gen(function* () {
    const rows = yield* sql`SELECT snapshot, url, read_by FROM computer_snapshot`.pipe(
      Effect.flatMap(decodeSnapshots),
    );

    return Option.map(Array.head(rows), (row) => ({
      snapshot: row.snapshot,
      url: row.url,
      readBy: row.read_by,
    }));
  }).pipe(Effect.withSpan("SnapshotStore.latest"));

  const save = Effect.fn("SnapshotStore.save")(function* (read: PageRead, readBy: BotId) {
    yield* sql`
      INSERT INTO computer_snapshot (id, snapshot, url, read_by)
      VALUES (1, ${read.snapshot}, ${read.url}, ${readBy})
      ON CONFLICT (id) DO UPDATE
      SET snapshot = excluded.snapshot, url = excluded.url, read_by = excluded.read_by,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `;
  });

  /** Forgets the latest snapshot, so no ref resolves until a Bot reads the page again. */
  const forget = sql`DELETE FROM computer_snapshot`.pipe(
    Effect.asVoid,
    Effect.withSpan("SnapshotStore.forget"),
  );

  return { latest, save, forget };
});
