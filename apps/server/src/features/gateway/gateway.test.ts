import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { auditLogLayer, migrateAudit } from "../audit/public.ts";
import { Gateway, gatewayLayer } from "./gateway.ts";

const testGateway = gatewayLayer.pipe(
  Layer.provide(auditLogLayer),
  Layer.provideMerge(Layer.effectDiscard(migrateAudit)),
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
  Layer.fresh,
);

describe("Gateway", () => {
  it.effect("writes a refusal as a deny row naming the agent, in the trace that asked", () =>
    Effect.gen(function* () {
      const gateway = yield* Gateway;
      const sql = yield* SqlClient.SqlClient;

      const traceId = yield* gateway
        .refuse({ agent: "codex", action: "terminal/create", detail: { command: "[3 chars]" } })
        .pipe(
          Effect.andThen(Effect.currentSpan),
          Effect.map((span) => span.traceId),
          Effect.withSpan("Chat.turn"),
        );

      const rows = yield* sql`
        SELECT trace_id, initiator_kind, actor_id, decision, action, detail FROM audit_rows
      `;

      expect(rows).toEqual([
        {
          trace_id: traceId,
          initiator_kind: "person",
          actor_id: "single-user",
          decision: "deny",
          action: "terminal/create",
          detail: JSON.stringify({ agent: "codex", request: { command: "[3 chars]" } }),
        },
      ]);
    }).pipe(Effect.provide(testGateway)),
  );
});
