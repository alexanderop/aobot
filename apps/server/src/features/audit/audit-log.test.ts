import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql";
import { AuditLog } from "./audit-log.ts";
import { testAuditDatabase } from "./testing/test-audit-database.ts";

const entry = {
  traceId: Option.some("trace-1"),
  initiatorKind: "person",
  actorId: "single-user",
  decision: "deny",
  action: "terminal/create",
  detail: { agent: "claude-code", command: "[3 chars]" },
} as const;

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
});
