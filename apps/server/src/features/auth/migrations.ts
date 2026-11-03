import { SqliteMigrator } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

const createPeople = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A removed person keeps their row, so their address stays blocked and the trail's actor_id still
  // names someone. An address removed before it ever signed in has no subject and no name.
  yield* sql`
    CREATE TABLE people (
      email text PRIMARY KEY,
      subject text,
      name text NOT NULL DEFAULT '',
      admin_granted integer NOT NULL DEFAULT 0 CHECK (admin_granted IN (0, 1)),
      created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      last_signed_in text,
      removed_at text
    )
  `;
});

const createSessions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Only a hash of each token: the database alone signs nobody in.
  yield* sql`
    CREATE TABLE sessions (
      token_hash text PRIMARY KEY,
      email text NOT NULL REFERENCES people (email),
      created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      expires_at text NOT NULL
    )
  `;

  yield* sql`CREATE INDEX sessions_by_person ON sessions (email)`;
});

/** Brings the people and their sessions up to date. Safe to run at every boot. */
export const migrateAuth = SqliteMigrator.run({
  table: "auth_migrations",
  loader: SqliteMigrator.fromRecord({
    "0001_create_people": createPeople,
    "0002_create_sessions": createSessions,
  }),
});
