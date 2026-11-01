import { SqliteMigrator } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

const refuseRewrites = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TRIGGER audit_rows_refuse_update BEFORE UPDATE ON audit_rows
    BEGIN SELECT RAISE(ABORT, 'audit rows cannot be changed'); END
  `;

  yield* sql`
    CREATE TRIGGER audit_rows_refuse_delete BEFORE DELETE ON audit_rows
    BEGIN SELECT RAISE(ABORT, 'audit rows cannot be deleted'); END
  `;
});

const createAuditRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE audit_rows (
      seq integer PRIMARY KEY AUTOINCREMENT,
      id text NOT NULL UNIQUE,
      created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      trace_id text,
      initiator_kind text NOT NULL CHECK (initiator_kind IN ('person', 'deployment')),
      actor_id text NOT NULL,
      decision text NOT NULL CHECK (decision IN ('allow', 'deny', 'failed')),
      action text NOT NULL,
      detail text NOT NULL
    )
  `;

  yield* refuseRewrites;
});

// SQLite cannot change a CHECK in place, so the table is rebuilt with every row kept, seq included.
const addOutcomeRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE audit_rows_next (
      seq integer PRIMARY KEY AUTOINCREMENT,
      id text NOT NULL UNIQUE,
      created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      trace_id text,
      initiator_kind text NOT NULL CHECK (initiator_kind IN ('person', 'deployment')),
      actor_id text NOT NULL,
      decision text NOT NULL
        CHECK (decision IN ('allow', 'deny', 'succeeded', 'failed', 'unknown')),
      action text NOT NULL,
      detail text NOT NULL,
      outcome_of text,
      CHECK ((decision IN ('allow', 'deny')) = (outcome_of IS NULL))
    )
  `;

  yield* sql`
    INSERT INTO audit_rows_next
      (seq, id, created_at, trace_id, initiator_kind, actor_id, decision, action, detail)
    SELECT seq, id, created_at, trace_id, initiator_kind, actor_id, decision, action, detail
    FROM audit_rows
  `;

  yield* sql`DROP TABLE audit_rows`;
  yield* sql`ALTER TABLE audit_rows_next RENAME TO audit_rows`;

  yield* refuseRewrites;

  yield* sql`
    CREATE UNIQUE INDEX audit_rows_one_outcome ON audit_rows (outcome_of)
    WHERE outcome_of IS NOT NULL
  `;

  yield* sql`
    CREATE TRIGGER audit_rows_outcome_of_allow BEFORE INSERT ON audit_rows
    WHEN NEW.outcome_of IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM audit_rows WHERE id = NEW.outcome_of AND decision = 'allow'
    )
    BEGIN SELECT RAISE(ABORT, 'an outcome follows an allow row'); END
  `;
});

/** Brings the audit table up to date. Safe to run at every boot. */
export const migrateAudit = SqliteMigrator.run({
  // Its own table, so the audit trail's migrations never share a numbering with another feature's.
  table: "audit_migrations",
  loader: SqliteMigrator.fromRecord({
    "0001_create_audit_rows": createAuditRows,
    "0002_add_outcome_rows": addOutcomeRows,
  }),
});
