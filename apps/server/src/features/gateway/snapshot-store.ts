import type { BotId } from "@aobot/domain";
import { Array, Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

const decodeSnapshots = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ snapshot: Schema.String })),
);

/**
The latest snapshot each Bot was shown, in the database rather than in memory, so whichever replica
handles a Bot's next call resolves its refs against the same page.
*/
export const snapshotStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const latest = Effect.fn("SnapshotStore.latest")(function* (bot: BotId) {
    const rows = yield* sql`SELECT snapshot FROM bot_snapshots WHERE bot_id = ${bot}`.pipe(
      Effect.flatMap(decodeSnapshots),
    );

    return Option.map(Array.head(rows), (row) => row.snapshot);
  });

  const save = Effect.fn("SnapshotStore.save")(function* (bot: BotId, snapshot: string) {
    yield* sql`
      INSERT INTO bot_snapshots (bot_id, snapshot) VALUES (${bot}, ${snapshot})
      ON CONFLICT (bot_id) DO UPDATE
      SET snapshot = excluded.snapshot, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `;
  });

  /** Forgets the Bot's latest snapshot, so none of its refs resolve until it reads a page again. */
  const forget = Effect.fn("SnapshotStore.forget")(function* (bot: BotId) {
    yield* sql`DELETE FROM bot_snapshots WHERE bot_id = ${bot}`;
  });

  return { latest, save, forget };
});
