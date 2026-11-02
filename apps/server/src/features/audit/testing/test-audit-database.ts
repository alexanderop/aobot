import { SqliteClient } from "@effect/sql-sqlite-node";
import { Layer } from "effect";
import { auditLogLayer } from "../audit-log.ts";
import { auditTrailLayer } from "../audit-trail.ts";
import { migrateAudit } from "../migrations.ts";

/**
A fresh in-memory SQLite database with the audit table, and an `AuditLog` and an `AuditTrail` on it, one
per test.
*/
export const testAuditDatabase = Layer.mergeAll(auditLogLayer, auditTrailLayer).pipe(
  Layer.provideMerge(Layer.effectDiscard(migrateAudit)),
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
  Layer.fresh,
);
