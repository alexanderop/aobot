import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MessageId } from "@aobot/domain";
import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer, Option, Queue, Stream, Tracer } from "effect";
import { Gateway, type Refusal } from "../../gateway/public.ts";
import { AgentEvent, AgentRuntime, ModelFailed, Stalled, type Turn } from "../agent-runtime.ts";
import type { FakeAgentScript } from "../testing/fake-acp-agent.ts";
import { layerAcp } from "./acp-runtime.ts";
import type { AcpLauncher } from "./launchers.ts";

const fakeAgent = fileURLToPath(new URL("../testing/fake-acp-agent.ts", import.meta.url));

const turn: Turn = {
  instructions: "Answer briefly.",
  history: [{ id: MessageId.make("message-1"), role: "user", text: "Say hi" }],
};

const quiet: FakeAgentScript = { chunks: [], ask: [], silent: false, pidFile: "", logFile: "" };

function launcherFor(script: FakeAgentScript): AcpLauncher {
  return {
    command: process.execPath,
    args: [fakeAgent],
    environment: () => Effect.succeed({ FAKE_ACP: JSON.stringify(script) }),
    sessionMeta: {},
  };
}

/** A gateway that keeps every refusal and the trace it happened in, instead of writing audit rows. */
function recordingGateway() {
  const refusals: Array<{ readonly refusal: Refusal; readonly traceId: Option.Option<string> }> =
    [];

  const layer = Layer.succeed(
    Gateway,
    Gateway.of({
      refuse: (refusal) =>
        Effect.option(Effect.currentSpan).pipe(
          Effect.map((span) => {
            refusals.push({ refusal, traceId: Option.map(span, (current) => current.traceId) });
          }),
        ),
      act: (action) => Effect.die(`these tests offer no computer, but ${action.action} ran`),
    }),
  );

  return { refusals, layer };
}

function runtimeWith(
  launcher: AcpLauncher,
  stallTimeout = Duration.seconds(10),
  gateway = recordingGateway().layer,
) {
  return layerAcp({
    agent: "fake-agent",
    launcher,
    home: tmpdir(),
    gatewayMcpUrl: "http://127.0.0.1:9/mcp",
    stallTimeout,
  }).pipe(
    Layer.provide(gateway),
    Layer.provide(NodeChildProcessSpawner.layer),
    Layer.provide([NodeFileSystem.layer, NodePath.layer]),
  );
}

const runTurn = Effect.gen(function* () {
  const agent = yield* AgentRuntime;

  return yield* agent.run(turn).pipe(Stream.runCollect);
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

function scratchFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "aobot-fake-acp-")), name);
}

describe("AgentRuntime (acp)", () => {
  it.live("streams the agent's message chunks as text, then done", () =>
    Effect.gen(function* () {
      const events = yield* runTurn;

      expect(events).toEqual([
        AgentEvent.TextDelta({ text: "Hi" }),
        AgentEvent.TextDelta({ text: " there" }),
        AgentEvent.Done(),
      ]);
    }).pipe(Effect.provide(runtimeWith(launcherFor({ ...quiet, chunks: ["Hi", " there"] })))),
  );

  it.live(
    "refuses a terminal and a permission through the gateway, inside the turn's trace",
    () => {
      const gateway = recordingGateway();

      return Effect.gen(function* () {
        const events = yield* runTurn;

        const text = events.flatMap((event) =>
          AgentEvent.$is("TextDelta")(event) ? [event.text] : [],
        );

        expect(text.join("")).toBe(
          'terminal/create: -32000\nsession/request_permission: {"outcome":{"outcome":"selected","optionId":"no"}}\nok',
        );

        expect(gateway.refusals.map(({ refusal }) => refusal)).toEqual([
          { agent: "fake-agent", action: "terminal/create", detail: { command: "[6 chars]" } },
          {
            agent: "fake-agent",
            action: "session/request_permission",
            detail: { kind: "execute", title: "[3 chars]" },
          },
        ]);
        expect(gateway.refusals.map(({ traceId }) => Option.isSome(traceId))).toEqual([true, true]);
      }).pipe(
        Effect.provide(
          runtimeWith(
            launcherFor({
              ...quiet,
              ask: [
                { method: "terminal/create", params: { command: "env", args: ["-0"] } },
                {
                  method: "session/request_permission",
                  params: {
                    toolCall: { toolCallId: "t", title: "env", kind: "execute" },
                    options: [
                      { optionId: "yes", name: "Allow", kind: "allow_once" },
                      { optionId: "no", name: "Reject", kind: "reject_once" },
                    ],
                  },
                },
              ],
              chunks: ["ok"],
            }),
            Duration.seconds(10),
            gateway.layer,
          ),
        ),
      );
    },
  );

  it.live("records the turn as AgentRuntime.turn with the CLI's name and version", () => {
    const spans: Array<Tracer.Span> = [];

    const tracer = Tracer.make({
      span: (options) => {
        const span = Tracer.nativeTracer.span(options);
        spans.push(span);

        return span;
      },
    });

    return Effect.gen(function* () {
      yield* runTurn;

      const turns = spans.filter((span) => span.name === "AgentRuntime.turn");
      expect(turns.map((span) => Object.fromEntries(span.attributes))).toEqual([
        {
          "agent.cli": "fake-agent",
          "agent.cli.adapter": "fake-acp-agent",
          "agent.cli.version": "9.9.9",
        },
      ]);
    }).pipe(
      Effect.provide(runtimeWith(launcherFor({ ...quiet, chunks: ["Hi"] }))),
      Effect.provide(Layer.succeed(Tracer.Tracer, tracer)),
    );
  });

  it.live("on stop, cancels the session and ends the agent's whole process group", () => {
    const pidFile = scratchFile("pids");
    const logFile = scratchFile("log");

    return Effect.gen(function* () {
      const agent = yield* AgentRuntime;
      const seen = yield* Queue.unbounded<AgentEvent>();

      const fiber = yield* agent.run(turn).pipe(
        Stream.runForEach((event) => Queue.offer(seen, event)),
        Effect.forkChild,
      );

      expect(yield* Queue.take(seen)).toEqual(AgentEvent.TextDelta({ text: "Thinking" }));

      const pids = readFileSync(pidFile, "utf8").trim().split("\n").map(Number);
      expect(pids.map(isAlive)).toEqual([true, true]);

      yield* Fiber.interrupt(fiber);

      expect(pids.map(isAlive)).toEqual([false, false]);
      expect(readFileSync(logFile, "utf8").split("\n")).toContain("session/cancel");
    }).pipe(
      Effect.provide(
        runtimeWith(
          launcherFor({ ...quiet, chunks: ["Thinking"], silent: true, pidFile, logFile }),
        ),
      ),
    );
  });

  it.live("fails with Stalled when the agent goes silent past the stall limit", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(runTurn);

      expect(error).toEqual(new Stalled({ waitedMs: 300 }));
    }).pipe(
      Effect.provide(runtimeWith(launcherFor({ ...quiet, silent: true }), Duration.millis(300))),
    ),
  );

  it.live("fails with the agent's last words when it exits before answering", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(runTurn);

      expect(error).toEqual(
        new ModelFailed({
          reason: "fake-agent exited before it answered: dyld: Library not loaded",
        }),
      );
    }).pipe(
      Effect.provide(
        runtimeWith({
          command: process.execPath,
          args: [
            "-e",
            "console.error('starting'); console.error('dyld: Library not loaded'); process.exit(1)",
          ],
          environment: () => Effect.succeed({}),
          sessionMeta: {},
        }),
      ),
    ),
  );
});
