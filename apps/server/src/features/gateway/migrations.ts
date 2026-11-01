import { SqliteMigrator } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

const createBotSnapshots = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE bot_snapshots (
      bot_id text PRIMARY KEY,
      snapshot text NOT NULL,
      updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `;
});

const createBotControl = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A row means a person holds the Bot's computer; handing it back deletes the row.
  yield* sql`
    CREATE TABLE bot_control (
      bot_id text PRIMARY KEY,
      since text NOT NULL
    )
  `;
});

const shareComputerControl = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Every Bot shares the one computer, so a person holds it for all of them: one row at most.
  yield* sql`
    CREATE TABLE computer_control (
      id integer PRIMARY KEY CHECK (id = 1),
      since text NOT NULL
    )
  `;

  yield* sql`
    INSERT INTO computer_control (id, since)
    SELECT 1, since FROM bot_control ORDER BY since LIMIT 1
  `;

  yield* sql`DROP TABLE bot_control`;
});

/** Brings the gateway's tables up to date. Safe to run at every boot. */
export const migrateGateway = SqliteMigrator.run({
  table: "gateway_migrations",
  loader: SqliteMigrator.fromRecord({
    "0001_create_bot_snapshots": createBotSnapshots,
    "0002_create_bot_control": createBotControl,
    "0003_share_computer_control": shareComputerControl,
  }),
});
