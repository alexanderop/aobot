import { SqliteMigrator } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

const createBotPauses = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A row means the Bot is paused; resuming it deletes the row.
  yield* sql`
    CREATE TABLE bot_pauses (
      bot_id text PRIMARY KEY,
      paused_by text NOT NULL,
      paused_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `;
});

/** Brings the lifecycle's tables up to date. Safe to run at every boot. */
export const migrateLifecycle = SqliteMigrator.run({
  table: "lifecycle_migrations",
  loader: SqliteMigrator.fromRecord({ "0001_create_bot_pauses": createBotPauses }),
});
