import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql";
import { AuditLog, type DecisionEntry } from "./audit-log.ts";
import { testAuditDatabase } from "./testing/test-audit-database.ts";

const entry = {
  traceId: Option.some("trace-1"),
  initiatorKind: "person",
  actorId: "single-user",
  decision: "deny",
  action: "terminal/create",
  detail: { agent: "claude-code", command: "[3 chars]" },
} as const;

const allow: DecisionEntry = {
  traceId: Option.some("trace-2"),
  initiatorKind: "person",
  actorId: "single-user",
  decision: "allow",
  action: "navigate",
  detail: { url: "https://example.com" },
};

const auditRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return yield* sql`
    SELECT id, trace_id, initiator_kind, actor_id, decision, action, detail, outcome_of
    FROM audit_rows ORDER BY seq
  `;
});

describe("AuditLog", () => {
  it.effect("keeps a recorded row as written", () =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const sql = yield* SqlClient.SqlClient;

      yield* audit.record(entry);

      const rows = yield* sql`
        SELECT trace_id, initiator_kind, actor_id, decision, action, detail FROM audit_rows
      `;

      expect(rows).toEqual([
        {
          trace_id: "trace-1",
          initiator_kind: "person",
          actor_id: "single-user",
          decision: "deny",
          action: "terminal/create",
          detail: JSON.stringify(entry.detail),
        },
      ]);
    }).pipe(Effect.provide(testAuditDatabase)),
  );

  it.effect("refuses to change or delete a row", () =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const sql = yield* SqlClient.SqlClient;

      yield* audit.record(entry);

      const update = yield* Effect.flip(sql`UPDATE audit_rows SET decision = 'allow'`);
      expect(String(update.reason.cause)).toContain("audit rows cannot be changed");

      const remove = yield* Effect.flip(sql`DELETE FROM audit_rows`);
      expect(String(remove.reason.cause)).toContain("audit rows cannot be deleted");

      const [row] = yield* sql`SELECT decision FROM audit_rows`;
      expect(row).toEqual({ decision: "deny" });
    }).pipe(Effect.provide(testAuditDatabase)),
  );

  it.effect(
    "follows an allow row with its outcome, in the same trace and for the same action",
    () =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;

        const allowRow = yield* audit.record(allow);
        yield* audit.recordOutcome({
          allowRow,
          initiatorKind: "person",
          outcome: "succeeded",
          detail: {},
        });

        const [, outcome] = yield* auditRows;
        expect(outcome).toEqual({
          id: expect.any(String),
          trace_id: "trace-2",
          initiator_kind: "person",
          actor_id: "single-user",
          decision: "succeeded",
          action: "navigate",
          detail: "{}",
          outcome_of: allowRow,
        });
      }).pipe(Effect.provide(testAuditDatabase)),
  );

  it.effect("refuses a second outcome, and an outcome for anything but an allow row", () =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;

      const allowRow = yield* audit.record(allow);
      const denyRow = yield* audit.record(entry);
      const outcome = { initiatorKind: "person", outcome: "failed", detail: {} } as const;

      yield* audit.recordOutcome({ ...outcome, allowRow });

      const second = yield* Effect.flip(audit.recordOutcome({ ...outcome, allowRow }));
      expect(second._tag).toBe("AuditWriteFailed");

      const afterDeny = yield* Effect.flip(audit.recordOutcome({ ...outcome, allowRow: denyRow }));
      expect(afterDeny._tag).toBe("AuditWriteFailed");

      expect((yield* auditRows).map((row) => row["decision"])).toEqual(["allow", "deny", "failed"]);
    }).pipe(Effect.provide(testAuditDatabase)),
  );

  it.effect("marks every allow row left without an outcome unknown, once, as the deployment", () =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;

      const finished = yield* audit.record(allow);
      yield* audit.recordOutcome({
        allowRow: finished,
        initiatorKind: "person",
        outcome: "succeeded",
        detail: {},
      });
      const unfinished = yield* audit.record({ ...allow, action: "snapshot", detail: {} });
      yield* audit.record(entry);

      expect(yield* audit.settleUnfinished).toBe(1);
      expect(yield* audit.settleUnfinished).toBe(0);

      const rows = yield* auditRows;
      expect(rows.filter((row) => row["decision"] === "unknown")).toEqual([
        {
          id: expect.any(String),
          trace_id: "trace-2",
          initiator_kind: "deployment",
          actor_id: "single-user",
          decision: "unknown",
          action: "snapshot",
          detail: expect.any(String),
          outcome_of: unfinished,
        },
      ]);
    }).pipe(Effect.provide(testAuditDatabase)),
  );
});
