import { createServer } from "node:http";
import {
  BotId,
  CommandEnd,
  type CommandRan,
  type ComputerAction,
  type ComputerActResult,
} from "@aobot/domain";
import { NodeHttpServer } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import { Context, Deferred, Duration, Effect, Fiber, Layer, Tracer } from "effect";
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
import { migrateGateway } from "./snapshot-store.ts";

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

/** A computer whose browser is on example.com. */
const exampleDomain = (action: ComputerAction): Effect.Effect<ComputerActResult> =>
  action.action === "run"
    ? Effect.die("this computer only has a browser")
    : Effect.succeed({
        action: action.action,
        url: "https://example.com/",
        title: "Example Domain",
        snapshot: '- heading "Example Domain" [level=1] [ref=e1]',
        truncated: false,
      });

const database = Layer.effectDiscard(Effect.andThen(migrateAudit, migrateGateway)).pipe(
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

const bot = BotId.make("assistant");

const { Exited, Signalled, TimedOut } = CommandEnd.cases;

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
          Gateway.use((gateway) => gateway.act(bot, navigate)),
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
          Effect.flip(gateway.act(bot, { action: "navigate", url: "http://10.0.0.1" })),
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

      const error = yield* Gateway.use((gateway) => Effect.flip(gateway.act(bot, navigate))).pipe(
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
        sql`DROP TABLE audit_rows`.pipe(Effect.andThen(Effect.flip(gateway.act(bot, navigate)))),
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

      const answer = yield* Gateway.use((gateway) => gateway.act(bot, { action: "snapshot" })).pipe(
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
        Effect.flip(gateway.act(bot, { action: "snapshot" })),
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
        yield* Gateway.use((gateway) => gateway.act(bot, navigate)).pipe(
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

/** A computer whose every answer is the page `snapshots` shows next, the last one from then on. */
function pages(...snapshots: ReadonlyArray<string>) {
  let shown = 0;

  return fakeComputers((action) =>
    action.action === "run"
      ? Effect.die("this computer only has a browser")
      : Effect.sync(() => ({
          action: action.action,
          url: "https://example.com/form",
          title: "Form",
          snapshot: snapshots[Math.min(shown++, snapshots.length - 1)] ?? "",
          truncated: false,
        })),
  );
}

const form = `- generic [ref=e1]:
  - textbox "Name" [ref=e2]
  - button "Send" [ref=e3]`;

const sent = `- generic [ref=e1]:
  - heading "Thank you" [level=1] [ref=e4]`;

describe("Gateway refs", () => {
  it.effect(
    "denies a click on a ref missing from the latest snapshot, before the computer hears of it",
    () =>
      Effect.gen(function* () {
        const computer = pages(form);

        const error = yield* Gateway.use((gateway) =>
          gateway
            .act(bot, { action: "snapshot" })
            .pipe(Effect.andThen(Effect.flip(gateway.act(bot, { action: "click", ref: "e9" })))),
        ).pipe(Effect.provide(startGateway(computer.layer)));

        expect(error).toBeInstanceOf(ToolFailed);
        expect(error.message).toBe(
          "click did not run: e9 is not a ref in your latest snapshot. Take a snapshot and use a ref from it.",
        );
        expect(computer.actions).toEqual([{ action: "snapshot" }]);

        const deny = (yield* auditRows).at(-1);
        expect(deny).toMatchObject({
          decision: "deny",
          action: "click",
          detail: JSON.stringify({ ref: "e9", reason: "not in the latest snapshot" }),
          outcome_of: null,
        });
      }).pipe(Effect.provide(database)),
  );

  it.effect("denies a ref before the Bot has seen any page", () =>
    Effect.gen(function* () {
      const computer = pages(form);

      const error = yield* Gateway.use((gateway) =>
        Effect.flip(gateway.act(bot, { action: "type", ref: "e2", text: "Ada" })),
      ).pipe(Effect.provide(startGateway(computer.layer)));

      expect(error.message).toContain("e2 is not a ref in your latest snapshot");
      expect(computer.actions).toEqual([]);
      expect(yield* auditRows).toMatchObject([
        {
          decision: "deny",
          action: "type",
          detail: JSON.stringify({ ref: "e2", reason: "there is no snapshot yet" }),
        },
      ]);
    }).pipe(Effect.provide(database)),
  );

  it.effect(
    "sends the computer the element the ref names, and records its role and name with the typed text redacted",
    () =>
      Effect.gen(function* () {
        const computer = pages(form);

        yield* Gateway.use((gateway) =>
          Effect.all([
            gateway.act(bot, { action: "snapshot" }),
            gateway.act(bot, { action: "type", ref: "e2", text: "hunter2 is my password" }),
            gateway.act(bot, { action: "click", ref: "e3" }),
          ]),
        ).pipe(Effect.provide(startGateway(computer.layer)));

        expect(computer.actions.slice(1)).toEqual([
          {
            action: "type",
            target: { ref: "e2", role: "textbox", name: "Name" },
            text: "hunter2 is my password",
          },
          { action: "click", target: { ref: "e3", role: "button", name: "Send" } },
        ]);

        const rows = yield* auditRows;
        const allowed = rows.filter((row) => row["decision"] === "allow");

        expect(allowed.map((row) => [row["action"], row["detail"]])).toEqual([
          ["snapshot", "{}"],
          [
            "type",
            JSON.stringify({ ref: "e2", role: "textbox", name: "Name", text: "[22 chars]" }),
          ],
          ["click", JSON.stringify({ ref: "e3", role: "button", name: "Send" })],
        ]);
        expect(JSON.stringify(rows)).not.toContain("hunter2");
      }).pipe(Effect.provide(database)),
  );

  it.effect("resolves the next ref against the page the last action answered with", () =>
    Effect.gen(function* () {
      const computer = pages(form, sent);

      const [clicked, gone, thanked] = yield* Gateway.use((gateway) =>
        Effect.gen(function* () {
          yield* gateway.act(bot, { action: "navigate", url: "https://example.com/form" });

          const clicked = yield* gateway.act(bot, { action: "click", ref: "e3" });
          const gone = yield* Effect.flip(gateway.act(bot, { action: "click", ref: "e3" }));
          const thanked = yield* gateway.act(bot, { action: "click", ref: "e4" });

          return [clicked, gone, thanked] as const;
        }),
      ).pipe(Effect.provide(startGateway(computer.layer)));

      expect(clicked).toContain('heading "Thank you"');
      expect(gone.message).toContain("e3 is not a ref in your latest snapshot");
      expect(thanked).toContain('heading "Thank you"');
      expect(computer.actions.map((action) => action.action)).toEqual([
        "navigate",
        "click",
        "click",
      ]);
    }).pipe(Effect.provide(database)),
  );

  it.effect("keeps each Bot's latest snapshot apart", () =>
    Effect.gen(function* () {
      const computer = pages(form);

      const error = yield* Gateway.use((gateway) =>
        gateway
          .act(bot, { action: "snapshot" })
          .pipe(
            Effect.andThen(
              Effect.flip(gateway.act(BotId.make("other"), { action: "click", ref: "e3" })),
            ),
          ),
      ).pipe(Effect.provide(startGateway(computer.layer)));

      expect(error.message).toContain("e3 is not a ref in your latest snapshot");
    }).pipe(Effect.provide(database)),
  );
});

/** What a command printed to one stream, all of it. */
const printed = (text: string) => ({ text, truncated: false });

/** A computer whose shell answers `ran` to every command, and whose browser is on example.com. */
function shell(ran: Partial<Omit<CommandRan, "action">>) {
  return fakeComputers((action) =>
    action.action === "run"
      ? Effect.succeed({
          action: "run",
          end: Exited.make({ code: 0 }),
          stdout: printed(""),
          stderr: printed(""),
          ...ran,
        })
      : exampleDomain(action),
  );
}

/** Every span started under it, so a test can read the attributes the gateway set. */
function recordedSpans() {
  const spans: Array<Tracer.Span> = [];

  const tracer = Tracer.make({
    span: (options) => {
      const span = Tracer.nativeTracer.span(options);
      spans.push(span);

      return span;
    },
  });

  return { spans, layer: Layer.succeed(Tracer.Tracer, tracer) };
}

const makeNotes = { action: "run", command: "echo hello > notes.txt && ls" } as const;

describe("Gateway run", () => {
  it.effect(
    "records the command, forwards it, and answers its exit code and output as untrusted command output",
    () =>
      Effect.gen(function* () {
        const computer = shell({
          stdout: printed("notes.txt\n"),
          stderr: printed("warning: hi\n"),
        });

        const tracing = recordedSpans();

        const answer = yield* Gateway.use((gateway) => gateway.act(bot, makeNotes)).pipe(
          Effect.provide(startGateway(computer.layer)),
          Effect.provide(tracing.layer),
        );

        expect(computer.actions).toEqual([makeNotes]);
        expect(answer).toContain('<untrusted_data source="command output">');
        expect(answer).toContain("Exit code: 0\n\nstdout:\nnotes.txt\n");
        expect(answer).toContain("stderr:\nwarning: hi\n");
        expect(answer).not.toContain("kept only the end");

        expect(
          (yield* auditRows).map((row) => [row["decision"], row["action"], row["detail"]]),
        ).toEqual([
          ["allow", "run", JSON.stringify({ command: makeNotes.command })],
          ["succeeded", "run", "{}"],
        ]);

        const span = tracing.spans.find((candidate) => candidate.name === "Gateway.act");
        expect(span?.attributes.get("gateway.command_end")).toBe("exited");
        expect(span?.attributes.get("gateway.exit_code")).toBe(0);
        expect(JSON.stringify([...(span?.attributes ?? [])])).not.toContain("notes.txt");
      }).pipe(Effect.provide(database)),
  );

  it.effect("tells the model a command failed by its exit code, and which output was cut", () =>
    Effect.gen(function* () {
      const computer = shell({
        end: Exited.make({ code: 2 }),
        stderr: { text: "ls: no such file\n", truncated: true },
      });

      const answer = yield* Gateway.use((gateway) =>
        gateway.act(bot, { action: "run", command: "ls /data/aobot.db" }),
      ).pipe(Effect.provide(startGateway(computer.layer)));

      expect(answer).toContain("Exit code: 2");
      expect(answer).toContain("stdout:\n(nothing)");
      expect(answer).toContain(
        "stderr:\nls: no such file\n\n[the computer kept only the end of stderr]",
      );
      expect(answer).not.toContain("the end of stdout");
    }).pipe(Effect.provide(database)),
  );

  it.effect("says a command was stopped at the computer's limit, which the call survives", () =>
    Effect.gen(function* () {
      const computer = shell({ end: TimedOut.make({}), stdout: printed("started\n") });
      const tracing = recordedSpans();

      const answer = yield* Gateway.use((gateway) =>
        gateway.act(bot, { action: "run", command: "sleep 600" }),
      ).pipe(Effect.provide(startGateway(computer.layer)), Effect.provide(tracing.layer));

      expect(answer).toContain("The command ran past 30s, so the computer stopped it.");
      expect(answer).toContain("stdout:\nstarted\n");
      expect((yield* auditRows).map((row) => row["decision"])).toEqual(["allow", "succeeded"]);

      const span = tracing.spans.find((candidate) => candidate.name === "Gateway.act");
      expect(span?.attributes.get("gateway.command_end")).toBe("timed_out");
      expect(span?.attributes.has("gateway.exit_code")).toBe(false);
    }).pipe(Effect.provide(database)),
  );

  it.effect("says which signal ended a command, with what it printed before", () =>
    Effect.gen(function* () {
      const computer = shell({
        end: Signalled.make({ signal: "SIGTERM" }),
        stdout: printed("before\n"),
      });

      const tracing = recordedSpans();

      const answer = yield* Gateway.use((gateway) =>
        gateway.act(bot, { action: "run", command: "echo before; kill -TERM $$" }),
      ).pipe(Effect.provide(startGateway(computer.layer)), Effect.provide(tracing.layer));

      expect(answer).toContain("The command was ended by SIGTERM.");
      expect(answer).toContain("stdout:\nbefore\n");
      expect((yield* auditRows).map((row) => row["decision"])).toEqual(["allow", "succeeded"]);

      const span = tracing.spans.find((candidate) => candidate.name === "Gateway.act");
      expect(span?.attributes.get("gateway.command_end")).toBe("signalled");
      expect(span?.attributes.get("gateway.signal")).toBe("SIGTERM");
      expect(span?.attributes.has("gateway.exit_code")).toBe(false);
    }).pipe(Effect.provide(database)),
  );

  it.effect("waits past the computer's 30 seconds before calling a command unknown", () =>
    Effect.gen(function* () {
      const computer = fakeComputers(() => Effect.never);

      const running = yield* Gateway.use((gateway) =>
        Effect.flip(gateway.act(bot, { action: "run", command: "sleep 600" })),
      ).pipe(Effect.provide(startGateway(computer.layer)), Effect.forkChild);

      yield* TestClock.adjust(Duration.seconds(31));
      expect(running.pollUnsafe()).toBeUndefined();

      yield* TestClock.adjust(Duration.seconds(10));
      expect((yield* Fiber.join(running)).message).toContain("unknown");
      expect((yield* auditRows).map((row) => row["decision"])).toEqual(["allow", "unknown"]);
    }).pipe(Effect.provide(database)),
  );

  it.effect("keeps the Bot's latest page when a command answers, so its refs still resolve", () =>
    Effect.gen(function* () {
      const computer = shell({ stdout: printed("- heading [ref=e9]\n") });

      yield* Gateway.use((gateway) =>
        Effect.all([
          gateway.act(bot, { action: "snapshot" }),
          gateway.act(bot, { action: "run", command: "cat page.txt" }),
          gateway.act(bot, { action: "click", ref: "e1" }),
        ]),
      ).pipe(Effect.provide(startGateway(computer.layer)));

      expect(computer.actions.at(-1)).toEqual({
        action: "click",
        target: { ref: "e1", role: "heading", name: "Example Domain" },
      });
    }).pipe(Effect.provide(database)),
  );

  it.effect("caps a very long command in its audit row", () =>
    Effect.gen(function* () {
      const command = `echo ${"x".repeat(5_000)}`;

      yield* Gateway.use((gateway) => gateway.act(bot, { action: "run", command })).pipe(
        Effect.provide(startGateway(shell({}).layer)),
      );

      const [allow] = yield* auditRows;
      const recorded = JSON.parse(String(allow?.["detail"])).command;
      expect(recorded.length).toBeLessThan(2_100);
      expect(recorded).toMatch(/^echo x+\n\[truncated: \d+ characters\]$/u);
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
