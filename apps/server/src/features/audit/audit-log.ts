import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

/** Who an action was done for: a person who was watching, or the deployment itself. */
type InitiatorKind = "person" | "deployment";

/** What the gateway decided about a call. */
type Decision = "allow" | "deny";

/**
What became of an allowed call. `unknown` means the server stopped hearing about it before it heard back,
so the action may or may not have happened. It is never run again.
*/
export type Outcome = "succeeded" | "failed" | "unknown";

/** One audit row. */
export const AuditRowId = Schema.String.pipe(Schema.brand("AuditRowId"));

/** A decoded {@link AuditRowId}. */
export type AuditRowId = typeof AuditRowId.Type;

/** One decision to record. `detail` must already be redacted: it is stored as written. */
export interface DecisionEntry {
  readonly traceId: Option.Option<string>;
  readonly initiatorKind: InitiatorKind;
  readonly actorId: string;
  readonly decision: Decision;
  readonly action: string;
  readonly detail: Schema.JsonObject;
}

/** What became of the `allow` row `allowRow`. Its action, actor and trace are copied from that row. */
export interface OutcomeEntry {
  readonly allowRow: AuditRowId;
  readonly initiatorKind: InitiatorKind;
  readonly outcome: Outcome;
  readonly detail: Schema.JsonObject;
}

/** A row could not be written. Whatever asked for it must not go ahead. */
export class AuditWriteFailed extends Schema.TaggedError<AuditWriteFailed>()("AuditWriteFailed", {
  message: Schema.String,
}) {}

const decodeUnfinished = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ id: AuditRowId })),
);

/**
The audit trail. Rows are only ever added; the table refuses UPDATE and DELETE. An `allow` row gets
exactly one outcome row later.
*/
export class AuditLog extends Context.Service<
  AuditLog,
  {
    readonly record: (entry: DecisionEntry) => Effect.Effect<AuditRowId, AuditWriteFailed>;
    readonly recordOutcome: (entry: OutcomeEntry) => Effect.Effect<void, AuditWriteFailed>;
    /**
    Writes `unknown` for every `allow` row that has no outcome, as the deployment. Run at start-up: a row
    left like that belonged to a run that was killed before it heard back. Returns how many it wrote.
    */
    readonly settleUnfinished: Effect.Effect<number, AuditWriteFailed>;
  }
>()("aobot/audit/AuditLog") {}

function writeFailed(error: { readonly message: string }) {
  return new AuditWriteFailed({ message: error.message });
}

/** {@link AuditLog} on the app's SQLite database. */
export const auditLogLayer = Layer.effect(
  AuditLog,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const record = Effect.fn("AuditLog.record")(function* (entry: DecisionEntry) {
      const id = AuditRowId.make(crypto.randomUUID());

      yield* sql`
        INSERT INTO audit_rows (id, trace_id, initiator_kind, actor_id, decision, action, detail)
        VALUES (
          ${id},
          ${Option.getOrNull(entry.traceId)},
          ${entry.initiatorKind},
          ${entry.actorId},
          ${entry.decision},
          ${entry.action},
          ${JSON.stringify(entry.detail)}
        )
      `.pipe(Effect.mapError(writeFailed));

      return id;
    });

    // The subqueries read NULL for a row that does not exist, which the NOT NULL columns refuse.
    const recordOutcome = Effect.fn("AuditLog.recordOutcome")(function* (entry: OutcomeEntry) {
      yield* sql`
        INSERT INTO audit_rows
          (id, trace_id, initiator_kind, actor_id, decision, action, detail, outcome_of)
        VALUES (
          ${crypto.randomUUID()},
          (SELECT trace_id FROM audit_rows WHERE id = ${entry.allowRow}),
          ${entry.initiatorKind},
          (SELECT actor_id FROM audit_rows WHERE id = ${entry.allowRow}),
          ${entry.outcome},
          (SELECT action FROM audit_rows WHERE id = ${entry.allowRow}),
          ${JSON.stringify(entry.detail)},
          ${entry.allowRow}
        )
      `.pipe(Effect.mapError(writeFailed));
    });

    const settleUnfinished = Effect.gen(function* () {
      const rows = yield* sql`
        SELECT allowed.id FROM audit_rows AS allowed
        WHERE allowed.decision = 'allow'
          AND NOT EXISTS (SELECT 1 FROM audit_rows AS later WHERE later.outcome_of = allowed.id)
        ORDER BY allowed.seq
      `.pipe(Effect.flatMap(decodeUnfinished), Effect.mapError(writeFailed));

      yield* Effect.forEach(
        rows,
        ({ id }) =>
          recordOutcome({
            allowRow: id,
            initiatorKind: "deployment",
            outcome: "unknown",
            detail: { reason: "the server stopped before the outcome was recorded" },
          }),
        { discard: true },
      );

      return rows.length;
    }).pipe(Effect.withSpan("AuditLog.settleUnfinished"));

    return AuditLog.of({ record, recordOutcome, settleUnfinished });
  }),
);
