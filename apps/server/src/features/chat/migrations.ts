import { Effect } from "effect";
import { Migrator, SqlClient } from "effect/sql";

const createChat = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE conversations (
      id text PRIMARY KEY,
      bot_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  yield* sql`
    CREATE TABLE messages (
      seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id text NOT NULL UNIQUE,
      conversation_id text NOT NULL REFERENCES conversations (id),
      role text NOT NULL CHECK (role IN ('user', 'assistant')),
      text text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  yield* sql`CREATE INDEX messages_by_conversation ON messages (conversation_id, seq)`;

  yield* sql`
    CREATE TABLE conversation_leases (
      conversation_id text PRIMARY KEY,
      run_id text NOT NULL,
      expires_at timestamptz NOT NULL
    )
  `;
});

/** Brings the chat tables up to date. Safe to run at every boot. */
export const migrateChat = Migrator.make({})({
  loader: Migrator.fromRecord({ "0001_create_chat": createChat }),
});
