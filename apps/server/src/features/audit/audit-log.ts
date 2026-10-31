import { Context, Effect, Layer, Option, type Schema } from "effect";
import { SqlClient } from "effect/sql";

/** Who an action was done for: a person who was watching, or the deployment itself. */
type InitiatorKind = "person" | "deployment";

/** What the gateway decided. `failed` follows an `allow` whose action then broke. */
type AuditDecision = "allow" | "deny" | "failed";

/** One decision to record. `detail` must already be redacted: it is stored as written. */
interface AuditEntry {
  readonly traceId: Option.Option<string>;
  readonly initiatorKind: InitiatorKind;
  readonly actorId: string;
  readonly decision: AuditDecision;
  readonly action: string;
  readonly detail: Schema.JsonObject;
}

/** The audit trail. Rows are only ever added; the table refuses UPDATE and DELETE. */
export class AuditLog extends Context.Service<
  AuditLog,
  {
    readonly record: (entry: AuditEntry) => Effect.Effect<void>;
  }
>()("aobot/audit/AuditLog") {}

/** {@link AuditLog} on the app's SQLite database. */
export const auditLogLayer = Layer.effect(
  AuditLog,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // A row that cannot be written stops whatever asked for it, so no action happens unrecorded.
    const record = Effect.fn("AuditLog.record")(function* (entry: AuditEntry) {
      yield* sql`
        INSERT INTO audit_rows (id, trace_id, initiator_kind, actor_id, decision, action, detail)
        VALUES (
          ${crypto.randomUUID()},
          ${Option.getOrNull(entry.traceId)},
          ${entry.initiatorKind},
          ${entry.actorId},
          ${entry.decision},
          ${entry.action},
          ${JSON.stringify(entry.detail)}
        )
      `.pipe(Effect.orDie);
    });

    return AuditLog.of({ record });
  }),
);
