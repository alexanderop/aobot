import { SqliteMigrator } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

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

  yield* sql`
    CREATE TRIGGER audit_rows_refuse_update BEFORE UPDATE ON audit_rows
    BEGIN SELECT RAISE(ABORT, 'audit rows cannot be changed'); END
  `;

  yield* sql`
    CREATE TRIGGER audit_rows_refuse_delete BEFORE DELETE ON audit_rows
    BEGIN SELECT RAISE(ABORT, 'audit rows cannot be deleted'); END
  `;
});

/** Brings the audit table up to date. Safe to run at every boot. */
export const migrateAudit = SqliteMigrator.run({
  // Its own table, so the audit trail's migrations never share a numbering with another feature's.
  table: "audit_migrations",
  loader: SqliteMigrator.fromRecord({ "0001_create_audit_rows": createAuditRows }),
});
