import { SqliteClient } from "@effect/sql-sqlite-node";
import { Layer } from "effect";
import { auditLogLayer } from "../audit-log.ts";
import { migrateAudit } from "../migrations.ts";

/** A fresh in-memory SQLite database with the audit table and an `AuditLog` on it, one per test. */
export const testAuditDatabase = auditLogLayer.pipe(
  Layer.provideMerge(Layer.effectDiscard(migrateAudit)),
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
  Layer.fresh,
);
