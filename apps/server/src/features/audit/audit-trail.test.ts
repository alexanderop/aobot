import type { AuditQuery } from "@aobot/domain";
import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Option, Ref, type Schema } from "effect";
import { SqlClient, Statement } from "effect/sql";
import { AuditLog } from "./audit-log.ts";
import { AuditTrail, BadCursor } from "./audit-trail.ts";
import { testAuditDatabase } from "./testing/test-audit-database.ts";

interface Written {
  readonly createdAt: string;
  readonly decision: string;
  readonly action?: string;
  readonly person?: string;
  readonly detail?: Schema.JsonObject;
  readonly outcomeOf?: string;
}

/** Writes a row at `createdAt` exactly, as the column stores it, and answers its id. */
const write = (row: Written) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = crypto.randomUUID();

    yield* sql`
      INSERT INTO audit_rows
        (id, created_at, trace_id, initiator_kind, actor_id, decision, action, detail, outcome_of)
      VALUES (
        ${id}, ${row.createdAt}, ${`trace-${id}`}, 'person', ${row.person ?? "single-user"},
        ${row.decision}, ${row.action ?? "run"}, ${JSON.stringify(row.detail ?? {})},
        ${row.outcomeOf ?? null}
      )
    `;

    return id;
  });

const everything: AuditQuery = {
  bot: Option.none(),
  person: Option.none(),
  decision: Option.none(),
  from: Option.none(),
  to: Option.none(),
  cursor: Option.none(),
  limit: Option.none(),
};

/** The ids of the rows `query` lets through, newest first. */
const idsOf = (query: AuditQuery) =>
  Effect.flatMap(AuditTrail, (trail) =>
    Effect.map(trail.page(query), (page) => page.rows.map((row) => row.id)),
  );

/** The ids of every row, following each page's `next` from the first page, `limit` rows a page. */
const walk = (limit: number) =>
  Effect.gen(function* () {
    const trail = yield* AuditTrail;
    const ids: Array<string> = [];
    let cursor = Option.none<string>();

    do {
      const page = yield* trail.page({ ...everything, cursor, limit: Option.some(limit) });
      expect(page.rows.length).toBeLessThanOrEqual(limit);
      ids.push(...page.rows.map((row) => row.id));
      cursor = page.next;
    } while (Option.isSome(cursor) && ids.length < 100);

    return ids;
  });

/** A trail of five rows from three Bots and two people, a minute apart. */
const fiveRows = Effect.gen(function* () {
  const navigate = yield* write({
    createdAt: "2026-11-02T10:00:00.000Z",
    decision: "allow",
    action: "navigate",
    detail: { bot: "assistant", url: "https://example.com/", rule: "browse" },
  });

  const navigated = yield* write({
    createdAt: "2026-11-02T10:01:00.000Z",
    decision: "succeeded",
    action: "navigate",
    outcomeOf: navigate,
  });

  const notGranted = yield* write({
    createdAt: "2026-11-02T10:02:00.000Z",
    decision: "deny",
    detail: { bot: "researcher", reason: "not granted to researcher" },
  });

  const ruleRefused = yield* write({
    createdAt: "2026-11-02T10:03:00.000Z",
    decision: "deny",
    person: "dana",
    detail: { bot: "assistant", command: "rm -rf /tmp/x", rule: "no-rm-rf" },
  });

  const taken = yield* write({
    createdAt: "2026-11-02T10:04:00.000Z",
    decision: "allow",
    action: "control_taken",
  });

  return { navigate, navigated, notGranted, ruleRefused, taken };
});

describe("AuditTrail", () => {
  it.effect(
    "reads every row newest first, an outcome after its allow row in the same instant",
    () =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        const trail = yield* AuditTrail;
        const sql = yield* SqlClient.SqlClient;

        const allowRow = yield* audit.record({
          traceId: Option.some("trace-1"),
          initiatorKind: "person",
          actorId: "single-user",
          decision: "allow",
          action: "navigate",
          detail: { bot: "scribe", url: "https://example.com/" },
        });

        yield* audit.recordOutcome({
          allowRow,
          initiatorKind: "deployment",
          outcome: "unknown",
          detail: { reason: "lost" },
        });

        const stored = yield* sql<{ readonly id: string; readonly created_at: string }>`
        SELECT id, created_at FROM audit_rows ORDER BY seq
      `;

        const page = yield* trail.page(everything);

        expect(page.next).toEqual(Option.none());
        expect([...page.rows].reverse().map((row) => row.id)).toEqual(stored.map((row) => row.id));
        expect(page.rows.at(-1)).toEqual({
          id: allowRow,
          createdAt: stored[0]?.created_at,
          initiatorKind: "person",
          person: "single-user",
          bot: Option.some("scribe"),
          decision: "allow",
          action: "navigate",
          detail: { bot: "scribe", url: "https://example.com/" },
          traceId: Option.some("trace-1"),
        });
        expect(page.rows[0]).toMatchObject({
          initiatorKind: "deployment",
          bot: Option.some("scribe"),
          decision: "unknown",
          detail: { reason: "lost" },
        });
      }).pipe(Effect.provide(testAuditDatabase)),
  );

  it.effect("keeps only the rows of one Bot, an outcome row by the Bot of its allow row", () =>
    Effect.gen(function* () {
      const rows = yield* fiveRows;

      expect(yield* idsOf({ ...everything, bot: Option.some("assistant") })).toEqual([
        rows.ruleRefused,
        rows.navigated,
        rows.navigate,
      ]);
      expect(yield* idsOf({ ...everything, bot: Option.some("operator") })).toEqual([]);
    }).pipe(Effect.provide(testAuditDatabase)),
  );

  it.effect("keeps only the rows of one person, or of one decision", () =>
    Effect.gen(function* () {
      const rows = yield* fiveRows;

      expect(yield* idsOf({ ...everything, person: Option.some("dana") })).toEqual([
        rows.ruleRefused,
      ]);
      expect(yield* idsOf({ ...everything, decision: Option.some("deny") })).toEqual([
        rows.ruleRefused,
        rows.notGranted,
      ]);
      expect(
        yield* idsOf({
          ...everything,
          decision: Option.some("deny"),
          bot: Option.some("assistant"),
        }),
      ).toEqual([rows.ruleRefused]);
    }).pipe(Effect.provide(testAuditDatabase)),
  );

  it.effect("keeps the rows written from `from` on and before `to`", () =>
    Effect.gen(function* () {
      const rows = yield* fiveRows;

      expect(
        yield* idsOf({
          ...everything,
          from: Option.some(DateTime.makeUnsafe("2026-11-02T10:01:00Z")),
          to: Option.some(DateTime.makeUnsafe("2026-11-02T10:03:00Z")),
        }),
      ).toEqual([rows.notGranted, rows.navigated]);
      expect(
        yield* idsOf({
          ...everything,
          from: Option.some(DateTime.makeUnsafe("2026-11-02T10:03:30Z")),
        }),
      ).toEqual([rows.taken]);
    }).pipe(Effect.provide(testAuditDatabase)),
  );

  it.effect("pages every row written in the same instant exactly once, at any page size", () =>
    Effect.gen(function* () {
      const before = yield* write({ createdAt: "2026-11-02T09:59:59.999Z", decision: "deny" });

      const together = yield* Effect.forEach([1, 2, 3, 4, 5], () =>
        write({ createdAt: "2026-11-02T10:00:00.000Z", decision: "deny" }),
      );

      const after = yield* write({ createdAt: "2026-11-02T10:00:00.001Z", decision: "deny" });

      const newestFirst = [after, ...[...together].reverse(), before];

      expect(yield* walk(1)).toEqual(newestFirst);
      expect(yield* walk(2)).toEqual(newestFirst);
      expect(yield* walk(7)).toEqual(newestFirst);
    }).pipe(Effect.provide(testAuditDatabase)),
  );

  it.effect("says there is a next page only when there is one", () =>
    Effect.gen(function* () {
      const trail = yield* AuditTrail;
      yield* fiveRows;

      const four = yield* trail.page({ ...everything, limit: Option.some(4) });
      const five = yield* trail.page({ ...everything, limit: Option.some(5) });

      expect(Option.isSome(four.next)).toBe(true);
      expect(five.next).toEqual(Option.none());
    }).pipe(Effect.provide(testAuditDatabase)),
  );

  it.effect("refuses a cursor it cannot read", () =>
    Effect.gen(function* () {
      const trail = yield* AuditTrail;
      yield* fiveRows;

      const forged = Buffer.from('{"createdAt":"2026-11-02T10:00:00Z","seq":1}').toString(
        "base64url",
      );

      const refused = yield* trail
        .page({ ...everything, cursor: Option.some(forged) })
        .pipe(Effect.flip);

      expect(refused).toBeInstanceOf(BadCursor);
    }).pipe(Effect.provide(testAuditDatabase)),
  );

  it.effect("seeks a later page by the newest-first index instead of scanning the table", () =>
    Effect.gen(function* () {
      const trail = yield* AuditTrail;
      const sql = yield* SqlClient.SqlClient;
      yield* fiveRows;

      const first = yield* trail.page({ ...everything, limit: Option.some(2) });
      const ran = yield* Ref.make<ReadonlyArray<readonly [string, ReadonlyArray<unknown>]>>([]);

      yield* trail.page({ ...everything, cursor: first.next, limit: Option.some(2) }).pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement) =>
          Effect.as(
            Ref.update(ran, (compiled) => [...compiled, statement.compile()]),
            statement,
          ),
        ),
      );

      const [query] = yield* Ref.get(ran);

      const plan = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${query?.[0]}`,
        query?.[1],
      );

      expect(plan.map((step) => step.detail)).toContainEqual(
        expect.stringMatching(
          /^SEARCH entry USING INDEX audit_rows_newest_first \(created_at<\?\)/u,
        ),
      );
    }).pipe(Effect.provide(testAuditDatabase)),
  );
});
