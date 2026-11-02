import { auditPageLimit, type AuditQuery, type AuditRow, InitiatorKind } from "@aobot/domain";
import { Array as Arr, Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, type SqlError } from "effect/sql";

/** `created_at` as the column stores it: `strftime('%Y-%m-%dT%H:%M:%fZ')`, to the millisecond. */
const StoredInstant = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
);

/**
Where a row sits in the trail's order, newest first: its `created_at` as stored, then its `seq`, the order
rows were written in. Not its `id`, which is random: an allow row and its outcome often share an instant,
and the outcome must still read as the later of the two.
*/
const RowKey = Schema.Struct({
  createdAt: StoredInstant,
  seq: Schema.Int.check(Schema.isGreaterThan(0)),
});

/**
A page's cursor: the key of its last row as base64url JSON. It carries `created_at` as the column stores
it, so the next page starts exactly after that row, however many rows share its instant.
*/
const AuditCursor = Schema.StringFromBase64Url.pipe(Schema.decodeTo(Schema.fromJsonString(RowKey)));

const decodeCursor = Schema.decodeUnknownEffect(AuditCursor);

const encodeCursor = Schema.encodeSync(AuditCursor);

/** The query named a cursor this server cannot read. */
export class BadCursor extends Schema.TaggedError<BadCursor>()("BadCursor", {
  message: Schema.String,
}) {}

/** One page of the trail, newest first, and the cursor of the page after it when more follow. */
export interface TrailPage {
  readonly rows: ReadonlyArray<Omit<AuditRow, "traceUrl">>;
  readonly next: Option.Option<string>;
}

const StoredRow = Schema.Struct({
  seq: Schema.Int,
  id: Schema.String,
  created_at: Schema.String,
  trace_id: Schema.NullOr(Schema.String),
  initiator_kind: InitiatorKind,
  actor_id: Schema.String,
  bot: Schema.NullOr(Schema.String),
  decision: Schema.String,
  action: Schema.String,
  detail: Schema.fromJsonString(Schema.JsonObject),
});

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(StoredRow));

/** Reads the audit trail, for the audit page. It never writes. */
export class AuditTrail extends Context.Service<
  AuditTrail,
  {
    /** The page `query` asks for. A row stored in a shape the trail cannot read is a defect. */
    readonly page: (query: AuditQuery) => Effect.Effect<TrailPage, BadCursor | SqlError.SqlError>;
  }
>()("aobot/audit/AuditTrail") {}

/** {@link AuditTrail} on the app's SQLite database. */
export const auditTrailLayer = Layer.effect(
  AuditTrail,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const page = Effect.fn("AuditTrail.page")(function* (query: AuditQuery) {
      const after = yield* Effect.transposeOption(Option.map(query.cursor, decodeCursor)).pipe(
        Effect.mapError(
          () => new BadCursor({ message: "That cursor is not one this server can read." }),
        ),
      );

      const limit = Option.getOrElse(query.limit, () => auditPageLimit.default);

      // Only the filters that are set, so a later page seeks the (created_at, seq) index.
      const where = sql.and(
        Arr.getSomes([
          Option.map(query.bot, (bot) => sql`bot = ${bot}`),
          Option.map(query.person, (person) => sql`actor_id = ${person}`),
          Option.map(query.decision, (decision) => sql`decision = ${decision}`),
          Option.map(query.from, (from) => sql`created_at >= ${DateTime.formatIso(from)}`),
          Option.map(query.to, (to) => sql`created_at < ${DateTime.formatIso(to)}`),
          Option.map(after, (key) => sql`(created_at, seq) < (${key.createdAt}, ${key.seq})`),
        ]),
      );

      // An outcome row's own detail need not name the Bot, so it is read from the allow row it follows.
      const found = yield* sql`
        WITH trail AS (
          SELECT
            entry.seq, entry.id, entry.created_at, entry.trace_id, entry.initiator_kind, entry.actor_id,
            coalesce(json_extract(entry.detail, '$.bot'), json_extract(allowed.detail, '$.bot')) AS bot,
            entry.decision, entry.action, entry.detail
          FROM audit_rows AS entry
          LEFT JOIN audit_rows AS allowed ON allowed.id = entry.outcome_of
        )
        SELECT * FROM trail
        WHERE ${where}
        ORDER BY created_at DESC, seq DESC
        LIMIT ${limit + 1}
      `.pipe(Effect.flatMap((raw) => Effect.orDie(decodeRows(raw))));

      const shown = found.slice(0, limit);

      const rows = shown.map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        initiatorKind: row.initiator_kind,
        person: row.actor_id,
        bot: Option.fromNullOr(row.bot),
        decision: row.decision,
        action: row.action,
        detail: row.detail,
        traceId: Option.fromNullOr(row.trace_id),
      }));

      const last = shown.at(-1);

      return {
        rows,
        next:
          found.length > limit && last !== undefined
            ? Option.some(encodeCursor({ createdAt: last.created_at, seq: last.seq }))
            : Option.none(),
      };
    });

    return AuditTrail.of({ page });
  }),
);
