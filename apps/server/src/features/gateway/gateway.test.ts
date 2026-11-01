import { createServer } from "node:http";
import type { ComputerAction, ComputerActResult } from "@aobot/domain";
import { NodeHttpServer } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import { Context, Deferred, Duration, Effect, Fiber, Layer } from "effect";
import { McpClient, McpProtocol } from "effect/ai";
import { FetchHttpClient, HttpClient, HttpMiddleware, HttpRouter, HttpServer } from "effect/http";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { ToolFailed } from "../../shared/tool-result.ts";
import { auditLogLayer, migrateAudit } from "../audit/public.ts";
import {
  type Computer,
  ComputerActFailed,
  Computers,
  ComputerUnavailable,
} from "../computers/public.ts";
import { Gateway, gatewayLayer } from "./gateway.ts";
import { gatewayMcpLayer } from "./mcp.ts";

/** A computer that answers with `act`, and keeps every action it was sent. */
function fakeComputers(act: Computer["act"]) {
  const actions: Array<ComputerAction> = [];

  const computer: Computer = {
    act: (action) =>
      Effect.andThen(
        Effect.sync(() => actions.push(action)),
        act(action),
      ),
  };

  const layer = Layer.succeed(
    Computers,
    Computers.of({
      ensure: Effect.succeed(computer),
      stop: Effect.void,
      reset: Effect.void,
      list: Effect.succeed([]),
    }),
  );

  return { actions, layer };
}

const exampleDomain = (action: ComputerAction): Effect.Effect<ComputerActResult> =>
  Effect.succeed({
    action: action.action,
    url: "https://example.com/",
    title: "Example Domain",
    snapshot: '- heading "Example Domain" [level=1] [ref=e1]',
    truncated: false,
  });

const database = Layer.effectDiscard(migrateAudit).pipe(
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
  Layer.fresh,
);

/** A gateway on the database in the context, as one server start would build it. */
function startGateway(computers: Layer.Layer<Computers>) {
  return gatewayLayer.pipe(Layer.provide(auditLogLayer), Layer.provide(computers));
}

const auditRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return yield* sql`
    SELECT id, trace_id, initiator_kind, decision, action, detail, outcome_of
    FROM audit_rows ORDER BY seq
  `;
});

const navigate = { action: "navigate", url: "https://example.com" } as const;

describe("Gateway", () => {
  it.effect("writes a refusal as a deny row naming the agent, in the trace that asked", () =>
    Effect.gen(function* () {
      const traceId = yield* Gateway.use((gateway) =>
        gateway.refuse({
          agent: "codex",
          action: "terminal/create",
          detail: { command: "[3 chars]" },
        }),
      ).pipe(
        Effect.andThen(Effect.currentSpan),
        Effect.map((span) => span.traceId),
        Effect.withSpan("Chat.turn"),
        Effect.provide(startGateway(fakeComputers(exampleDomain).layer)),
      );

      expect(yield* auditRows).toEqual([
        {
          id: expect.any(String),
          trace_id: traceId,
          initiator_kind: "person",
          decision: "deny",
          action: "terminal/create",
          detail: JSON.stringify({ agent: "codex", request: { command: "[3 chars]" } }),
          outcome_of: null,
        },
      ]);
    }).pipe(Effect.provide(database)),
  );

  it.effect(
    "records an allow, forwards the call, records it succeeded, all in the asking trace",
    () =>
      Effect.gen(function* () {
        const computer = fakeComputers(exampleDomain);

        const [answer, traceId] = yield* Effect.all([
          Gateway.use((gateway) => gateway.act(navigate)),
          Effect.map(Effect.currentSpan, (span) => span.traceId),
        ]).pipe(Effect.withSpan("Chat.turn"), Effect.provide(startGateway(computer.layer)));

        expect(computer.actions).toEqual([navigate]);
        expect(answer).toContain('<untrusted_data source="web page">');
        expect(answer).toContain("Title: Example Domain");

        const [allow, outcome] = yield* auditRows;
        expect(allow).toMatchObject({
          trace_id: traceId,
          initiator_kind: "person",
          decision: "allow",
          action: "navigate",
          detail: JSON.stringify({ url: "https://example.com" }),
          outcome_of: null,
        });
        expect(outcome).toMatchObject({
          trace_id: traceId,
          decision: "succeeded",
          action: "navigate",
          outcome_of: allow?.["id"],
        });
      }).pipe(Effect.provide(database)),
  );

  it.effect(
    "records failed when the computer refuses, and tells the model instead of ending the turn",
    () =>
      Effect.gen(function* () {
        const computer = fakeComputers(() =>
          Effect.fail(
            new ComputerActFailed({ reason: "refused", message: "10.0.0.1 is a private address" }),
          ),
        );

        const error = yield* Gateway.use((gateway) =>
          Effect.flip(gateway.act({ action: "navigate", url: "http://10.0.0.1" })),
        ).pipe(Effect.provide(startGateway(computer.layer)));

        expect(error).toBeInstanceOf(ToolFailed);
        expect(error.message).toContain("refused");
        expect(error.message).toContain("10.0.0.1 is a private address");
        expect((yield* auditRows).map((row) => row["decision"])).toEqual(["allow", "failed"]);
      }).pipe(Effect.provide(database)),
  );

  it.effect("records failed when the computer cannot be started", () =>
    Effect.gen(function* () {
      const unavailable = Layer.succeed(
        Computers,
        Computers.of({
          ensure: Effect.fail(new ComputerUnavailable({ message: "Docker is not running." })),
          stop: Effect.void,
          reset: Effect.void,
          list: Effect.succeed([]),
        }),
      );

      const error = yield* Gateway.use((gateway) => Effect.flip(gateway.act(navigate))).pipe(
        Effect.provide(startGateway(unavailable)),
      );

      expect(error.message).toContain("Docker is not running.");
      expect((yield* auditRows).map((row) => row["decision"])).toEqual(["allow", "failed"]);
    }).pipe(Effect.provide(database)),
  );

  it.effect("does not forward a call whose audit row cannot be written", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const computer = fakeComputers(exampleDomain);

      const error = yield* Gateway.use((gateway) =>
        sql`DROP TABLE audit_rows`.pipe(Effect.andThen(Effect.flip(gateway.act(navigate)))),
      ).pipe(Effect.provide(startGateway(computer.layer)));

      expect(error).toBeInstanceOf(ToolFailed);
      expect(computer.actions).toEqual([]);
    }).pipe(Effect.provide(database)),
  );

  it.effect("hands the model a 50,000-character snapshot capped, with the note", () =>
    Effect.gen(function* () {
      const computer = fakeComputers(() =>
        Effect.succeed({
          action: "snapshot",
          url: "https://example.com/",
          title: "Long",
          snapshot: "x".repeat(50_000),
          truncated: false,
        }),
      );

      const answer = yield* Gateway.use((gateway) => gateway.act({ action: "snapshot" })).pipe(
        Effect.provide(startGateway(computer.layer)),
      );

      expect(answer).toMatch(/\n\[truncated: \d+ characters\]\n<\/untrusted_data>$/u);
      expect(answer.length).toBeGreaterThan(20_000);
      expect(answer.length).toBeLessThan(20_500);
    }).pipe(Effect.provide(database)),
  );

  it.effect("records unknown when the computer runs past its limit, and says so", () =>
    Effect.gen(function* () {
      const computer = fakeComputers(() => Effect.never);

      const running = yield* Gateway.use((gateway) =>
        Effect.flip(gateway.act({ action: "snapshot" })),
      ).pipe(Effect.provide(startGateway(computer.layer)), Effect.forkChild);

      yield* TestClock.adjust(Duration.minutes(1));
      const error = yield* Fiber.join(running);

      expect(error.message).toContain("unknown");
      expect((yield* auditRows).map((row) => row["decision"])).toEqual(["allow", "unknown"]);
    }).pipe(Effect.provide(database)),
  );

  it.effect(
    "leaves unknown, as the deployment, for a call a killed run never heard back from",
    () =>
      Effect.gen(function* () {
        const forwarded = yield* Deferred.make<void>();

        const hanging = fakeComputers(() =>
          Deferred.succeed(forwarded, undefined).pipe(Effect.andThen(Effect.never)),
        );

        // The first run forwards and never hears back; the next start of the server finds its row.
        yield* Gateway.use((gateway) => gateway.act(navigate)).pipe(
          Effect.provide(startGateway(hanging.layer)),
          Effect.forkChild,
        );
        yield* Deferred.await(forwarded);
        yield* Gateway.use(() => Effect.void).pipe(
          Effect.provide(startGateway(fakeComputers(exampleDomain).layer)),
        );

        const [allow, outcome] = yield* auditRows;
        expect(outcome).toMatchObject({
          initiator_kind: "deployment",
          decision: "unknown",
          action: "navigate",
          outcome_of: allow?.["id"],
        });
        expect(hanging.actions).toEqual([navigate]);
      }).pipe(Effect.provide(database)),
  );
});

describe("the gateway's MCP server", () => {
  it.live("runs a CLI's tool call inside the trace its traceparent names", () =>
    Effect.gen(function* () {
      const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";

      const server = yield* Layer.build(
        HttpRouter.serve(gatewayMcpLayer).pipe(
          Layer.provide(startGateway(fakeComputers(exampleDomain).layer)),
          Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
          // As in the server: HTTP requests start no spans, so only the gateway can link the trace.
          Layer.provide(Layer.succeed(HttpMiddleware.TracerDisabledWhen, () => true)),
        ),
      );

      const url = `${HttpServer.formatAddress(Context.get(server, HttpServer.HttpServer).address)}/mcp`;

      const result = yield* Effect.gen(function* () {
        const client = yield* McpClient.McpClient;
        const tools = yield* client.listTools();
        const tool = tools.find((candidate) => candidate.name === "navigate");
        expect(tool).toBeDefined();

        return yield* client.callTool({ tool: tool!, arguments: { url: "https://example.com" } });
      }).pipe(
        Effect.provide(
          McpClient.layerHttp({
            name: "test-cli",
            version: "0.0.0",
            protocol: McpProtocol.v2025_11_25,
            url,
            headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
          }).pipe(Layer.provide(FetchHttpClient.layer)),
        ),
        // Only the header above names a trace; the client's own propagation would name another.
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      );

      expect(JSON.stringify(result.content)).toContain("Example Domain");
      expect((yield* auditRows).map((row) => row["trace_id"])).toEqual([traceId, traceId]);
    }).pipe(Effect.provide(database), Effect.scoped),
  );
});
