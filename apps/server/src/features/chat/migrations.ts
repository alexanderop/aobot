import { Effect } from "effect";
import { SqliteMigrator } from "@effect/sql-sqlite-node";
import { SqlClient } from "effect/sql";

const createChat = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE conversations (
      id text PRIMARY KEY,
      bot_id text NOT NULL,
      created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `;

  yield* sql`
    CREATE TABLE messages (
      seq integer PRIMARY KEY AUTOINCREMENT,
      id text NOT NULL UNIQUE,
      conversation_id text NOT NULL REFERENCES conversations (id),
      role text NOT NULL CHECK (role IN ('user', 'assistant')),
      text text NOT NULL,
      created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `;

  yield* sql`CREATE INDEX messages_by_conversation ON messages (conversation_id, seq)`;
});

/** Brings the chat tables up to date. Safe to run at every boot. */
export const migrateChat = SqliteMigrator.run({
  loader: SqliteMigrator.fromRecord({ "0001_create_chat": createChat }),
});
