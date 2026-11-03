import { Effect } from "effect";
import { SqliteMigrator } from "@effect/sql-sqlite-node";
import { SqlClient } from "effect/sql";
import { actorId, type PersonActor } from "../../shared/actor.ts";

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

const addOwners = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The actor id of the person whose conversation it is, as audit rows name them. No reference to
  // `people`: the single user has no row there. A conversation from before has none, so it opens for
  // nobody unless the server runs in single-user mode, which adopts it.
  yield* sql`ALTER TABLE conversations ADD COLUMN owner_id text`;

  // The last message the owner has seen, so a Bot's message after it is unread.
  yield* sql`ALTER TABLE conversations ADD COLUMN read_seq integer NOT NULL DEFAULT 0`;

  yield* sql`CREATE INDEX conversations_by_owner ON conversations (owner_id)`;
});

/** Brings the chat tables up to date. Safe to run at every boot. */
export const migrateChat = SqliteMigrator.run({
  loader: SqliteMigrator.fromRecord({
    "0001_create_chat": createChat,
    "0002_add_owners": addOwners,
  }),
});

/**
Makes every conversation from before owners `person`'s: on a single-user server they wrote them all.
Safe to run at every boot, and touches no conversation that has an owner.
*/
export const adoptUnowned = Effect.fn("Chat.adoptUnowned")(function* (person: PersonActor) {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`UPDATE conversations SET owner_id = ${actorId(person)} WHERE owner_id IS NULL`;
});
