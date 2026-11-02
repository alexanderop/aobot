import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { AuditRowsPage } from "@aobot/domain";
import { NodeHttpServer } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { type Context, Effect, Exit, Layer, Option, Schema, Scope } from "effect";
import { HttpRouter } from "effect/http";
import {
  AuditLog,
  auditLogLayer,
  auditTrailLayer,
  migrateAudit,
} from "../features/audit/public.ts";
import { auditRoutes } from "./audit-routes.ts";

const database = Layer.effectDiscard(migrateAudit).pipe(
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
);

const http = createServer();

const scope = Effect.runSync(Scope.make());

let served: Context.Context<AuditLog>;

/** Writes three rows: a refusal in trace `trace-deny`, then an allowed call without a trace, and its outcome. */
const threeRows = Effect.gen(function* () {
  const audit = yield* AuditLog;
  const row = { initiatorKind: "person", actorId: "single-user" } as const;

  yield* audit.record({
    ...row,
    traceId: Option.some("trace-deny"),
    decision: "deny",
    action: "run",
    detail: { bot: "assistant", command: "rm -rf /tmp/x", rule: "no-rm-rf" },
  });

  const allowRow = yield* audit.record({
    ...row,
    traceId: Option.none(),
    decision: "allow",
    action: "navigate",
    detail: { bot: "researcher", url: "https://example.com/", rule: "browse" },
  });

  yield* audit.recordOutcome({ ...row, allowRow, outcome: "succeeded", detail: {} });
});

beforeAll(async () => {
  const server = HttpRouter.serve(
    auditRoutes(Option.none(), Option.some(new URL("http://grafana.test:3300/"))).pipe(
      Layer.provide(auditTrailLayer),
    ),
    { disableLogger: true, disableListenLog: true },
  ).pipe(
    Layer.provide(NodeHttpServer.layer(() => http, { port: 0, host: "127.0.0.1" })),
    Layer.provideMerge(auditLogLayer),
    Layer.provideMerge(database),
  );

  served = await Effect.runPromise(Layer.buildWithScope(server, scope));
  await Effect.runPromise(threeRows.pipe(Effect.provide(served)));
});

afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)));

function rowsUrl(query: Record<string, string>): string {
  // SAFETY: a server listening on a host and port, not a pipe, reports an `AddressInfo`.
  const { port } = http.address() as AddressInfo;

  return `http://127.0.0.1:${port}/audit/rows?${new URLSearchParams(query).toString()}`;
}

/** The trace a Grafana Explore link opens, as its `panes` names it. */
const decodePanes = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      trace: Schema.Struct({ queries: Schema.Tuple([Schema.Struct({ query: Schema.String })]) }),
    }),
  ),
);

/** The page `query` answers, which must be a 200. */
async function page(query: Record<string, string>) {
  const response = await fetch(rowsUrl(query), { headers: { "sec-fetch-site": "same-origin" } });

  expect(response.status).toBe(200);

  return Schema.decodeUnknownSync(AuditRowsPage)(await response.json());
}

const asCursor = (text: string) => Buffer.from(text).toString("base64url");

describe("GET /audit/rows", () => {
  it("answers the rows newest first, each with its Bot and a link to its trace in Grafana", async () => {
    const { rows, next } = await page({});

    expect(next).toEqual(Option.none());
    expect(rows.map(({ action, decision, bot }) => [action, decision, bot])).toEqual([
      ["navigate", "succeeded", Option.some("researcher")],
      ["navigate", "allow", Option.some("researcher")],
      ["run", "deny", Option.some("assistant")],
    ]);

    const refusal = rows[2];
    expect(refusal?.traceId).toEqual(Option.some("trace-deny"));

    const link = new URL(Option.getOrThrow(refusal?.traceUrl ?? Option.none()));
    expect(link.origin + link.pathname).toBe("http://grafana.test:3300/explore");
    expect(decodePanes(link.searchParams.get("panes")).trace.queries[0].query).toBe("trace-deny");

    expect(rows[0]?.traceUrl).toEqual(Option.none());
  });

  it("keeps only the rows the filters ask for", async () => {
    const { rows } = await page({ decision: "deny", bot: "assistant", person: "single-user" });

    expect(rows.map(({ action }) => action)).toEqual(["run"]);
  });

  it("follows a cursor it gave out to the next page, until there is none", async () => {
    const first = await page({ limit: "2" });
    const second = await page({ limit: "2", cursor: Option.getOrThrow(first.next) });

    expect([...first.rows, ...second.rows].map(({ decision }) => decision)).toEqual([
      "succeeded",
      "allow",
      "deny",
    ]);
    expect(second.next).toEqual(Option.none());
  });

  it.each([
    ["not base64url", "%%%"],
    ["not JSON", asCursor("created_at=now")],
    ["no fields", asCursor("{}")],
    ["a number for the instant", asCursor('{"createdAt":5,"seq":1}')],
    ["an instant in another format", asCursor('{"createdAt":"2026-11-02T10:00:00Z","seq":1}')],
    ["a seq that is text", asCursor('{"createdAt":"2026-11-02T10:00:00.000Z","seq":"1"}')],
    ["a seq below one", asCursor('{"createdAt":"2026-11-02T10:00:00.000Z","seq":0}')],
  ])("answers 400 to a cursor with %s", async (_kind, cursor) => {
    const response = await fetch(rowsUrl({ cursor }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      message: "That cursor is not one this server can read.",
    });
  });

  it.each<Record<string, string>>([
    { decision: "approved" },
    { limit: "0" },
    { limit: "201" },
    { limit: "ten" },
    { limit: "1.5" },
    { from: "yesterday" },
    { from: "+010000-01-01T00:00:00.000Z" },
    { to: "+010000-01-01T00:00:00.000Z" },
  ])("answers 400 to the query %j", async (query) => {
    const response = await fetch(rowsUrl(query));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      message: expect.stringContaining("The audit query is not one this server reads."),
    });
  });

  it("refuses a page from another site", async () => {
    const response = await fetch(rowsUrl({}), { headers: { origin: "https://evil.example" } });

    expect(response.status).toBe(403);
  });
});
