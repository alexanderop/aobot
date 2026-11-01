import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageId } from "@aobot/domain";
import {
  NodeChildProcessSpawner,
  NodeFileSystem,
  NodeHttpServer,
  NodePath,
} from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Redacted,
  Stream,
} from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import { botToolkit } from "../bots/public.ts";
import { botToolHandlers, Gateway, gatewayMcpLayer, type Refusal } from "../gateway/public.ts";
import { layerAcp } from "./acp/acp-runtime.ts";
import { acpAgents, type AcpAgentName, type AcpLauncher } from "./acp/launchers.ts";
import { AgentEvent, AgentRuntime, type Turn } from "./agent-runtime.ts";
import { layerApi } from "./api-runtime.ts";
import { languageModelLayer } from "./model-providers.ts";
import { type MockModelServer, startMockModel } from "./testing/mock-model-server.ts";
import { type ModelScript, ModelStep, type ScriptedToolCall } from "./testing/model-script.ts";

/**
Tier 3: every agent runtime behaves the same against the mock model server, and none of them lets the
model act outside the gateway. `vp run test:contract:agents`. Needs the network once to fetch the
pinned adapters through npx.
*/

const limits = { maxSteps: 4, stallTimeout: Duration.seconds(90) };

const turn: Turn = {
  instructions: "Answer briefly.",
  history: [{ id: MessageId.make("message-1"), role: "user", text: "Say hi" }],
};

const canary = `aobot-canary-${crypto.randomUUID()}`;

/** A line of `/etc/passwd`, on macOS and Linux alike. */
const passwdLine = /root:[^:\n]*:0:0:/u;

/** A gateway that keeps what it refused, so a test can show what the CLI asked for. */
function recordingGateway() {
  const refusals: Array<Refusal> = [];

  const layer = Layer.succeed(
    Gateway,
    Gateway.of({
      refuse: (refusal) => Effect.sync(() => void refusals.push(refusal)),
      act: (_bot, request) =>
        Effect.die(`the contract suite offers no computer, but ${request.action} ran`),
    }),
  );

  return { refusals, layer };
}

/** One runtime under test: how to build it against a mock model, and how its model would try to escape. */
interface Contender {
  readonly runtime: (
    mock: MockModelServer,
    gateway: Layer.Layer<Gateway>,
    gatewayMcpUrl: string,
  ) => Layer.Layer<AgentRuntime>;
  /** Calls to the CLI's own shell and file tools: run `env`, read `/etc/passwd`. */
  readonly escape: ReadonlyArray<ScriptedToolCall>;
  /**
  `api` fails the turn on a tool it does not have; a CLI tells the model the tool is unavailable and goes
  on to answer. Either way nothing ran.
  */
  readonly afterEscape: "fails" | "answers";
  /** A pattern in the command line of the CLI's processes, to see that none outlive a turn. */
  readonly processPattern: Option.Option<string>;
}

const origin = (mock: MockModelServer) => `http://127.0.0.1:${mock.port}`;

/** The launcher with the canary and the variables that point the CLI at the mock model added. */
function pointedAtMock(
  agent: AcpAgentName,
  mockEnvironment: (mock: MockModelServer) => Readonly<Record<string, string>>,
) {
  return (mock: MockModelServer, gateway: Layer.Layer<Gateway>, gatewayMcpUrl: string) => {
    const launcher: AcpLauncher = acpAgents[agent];

    return layerAcp({
      agent,
      launcher: {
        ...launcher,
        environment: (context) =>
          Effect.map(launcher.environment(context), (environment) => ({
            ...environment,
            ...mockEnvironment(mock),
            AOBOT_CANARY: canary,
          })),
      },
      // An empty home: the suite never touches the person's own sign-in.
      home: mkdtempSync(join(tmpdir(), "aobot-contract-home-")),
      gatewayMcpUrl,
      stallTimeout: limits.stallTimeout,
    }).pipe(
      Layer.provide(gateway),
      Layer.provide(NodeChildProcessSpawner.layer),
      Layer.provide([NodeFileSystem.layer, NodePath.layer]),
    );
  };
}

function openCodeConfig(mock: MockModelServer): string {
  const file = join(mkdtempSync(join(tmpdir(), "aobot-contract-opencode-")), "opencode.json");

  writeFileSync(
    file,
    JSON.stringify({
      model: "mock/mock",
      provider: {
        mock: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: `${origin(mock)}/v1`, apiKey: "mock" },
          models: { mock: {} },
        },
      },
    }),
  );

  return file;
}

const contender = (entry: Contender): Contender => entry;

const contenders = {
  api: contender({
    runtime: (mock, gateway) =>
      layerApi(botToolkit, limits).pipe(
        Layer.provide(botToolHandlers),
        Layer.provide(gateway),
        Layer.provide(
          languageModelLayer({
            provider: "openai-compat",
            name: "mock",
            apiKey: Redacted.make("mock"),
            baseUrl: Option.some(`${origin(mock)}/v1`),
          }),
        ),
        Layer.provide(FetchHttpClient.layer),
      ),
    escape: [
      { name: "bash", params: { command: "env" } },
      { name: "read_file", params: { path: "/etc/passwd" } },
    ],
    afterEscape: "fails",
    processPattern: Option.none(),
  }),
  "claude-code": contender({
    runtime: pointedAtMock("claude-code", (mock) => ({
      ANTHROPIC_BASE_URL: origin(mock),
      ANTHROPIC_API_KEY: "mock",
    })),
    escape: [
      { name: "Bash", params: { command: "env", description: "Print the environment" } },
      { name: "Read", params: { file_path: "/etc/passwd" } },
    ],
    afterEscape: "answers",
    processPattern: Option.some("claude-agent-acp"),
  }),
  codex: contender({
    runtime: pointedAtMock("codex", (mock) => ({
      CODEX_CONFIG: JSON.stringify({
        model: "mock",
        model_provider: "mock",
        model_providers: {
          mock: {
            name: "mock",
            base_url: `${origin(mock)}/v1`,
            wire_api: "responses",
            env_key: "AOBOT_MOCK_MODEL_KEY",
          },
        },
      }),
      AOBOT_MOCK_MODEL_KEY: "mock",
      DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: "api-key" }),
      CODEX_API_KEY: "mock",
    })),
    escape: [
      { name: "exec_command", params: { cmd: "env" } },
      { name: "shell", params: { command: ["cat", "/etc/passwd"] } },
    ],
    afterEscape: "answers",
    processPattern: Option.some("codex-acp"),
  }),
  opencode: contender({
    runtime: pointedAtMock("opencode", (mock) => ({ OPENCODE_CONFIG: openCodeConfig(mock) })),
    escape: [
      { name: "bash", params: { command: "env", description: "Print the environment" } },
      { name: "read", params: { filePath: "/etc/passwd" } },
    ],
    afterEscape: "answers",
    processPattern: Option.some("opencode-ai"),
  }),
} satisfies { readonly [Name in "api" | AcpAgentName]: Contender };

/** The gateway's MCP server on a free port, as the CLIs reach it from a running server. */
const gatewayMcpUrl = Effect.gen(function* () {
  const context = yield* Layer.build(
    HttpRouter.serve(gatewayMcpLayer).pipe(
      Layer.provide(recordingGateway().layer),
      Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
    ),
  );

  return `${HttpServer.formatAddress(Context.get(context, HttpServer.HttpServer).address)}/mcp`;
});

function mockModel(script: ModelScript, delayMs: number) {
  return Effect.acquireRelease(
    Effect.promise(() =>
      startMockModel({ script, afterLastStep: "fail", delayMs, host: "127.0.0.1", port: 0 }),
    ),
    (server) => Effect.promise(() => server.close()),
  );
}

function textOf(events: ReadonlyArray<AgentEvent>): string {
  return events
    .flatMap((event) => (AgentEvent.$is("TextDelta")(event) ? [event.text] : []))
    .join("");
}

/** How many processes now run with `pattern` in their command line. */
function processesMatching(pattern: string): number {
  try {
    return execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" }).trim().split("\n").length;
  } catch {
    return 0;
  }
}

const names = ["api", "claude-code", "codex", "opencode"] as const;

describe.each(names)("the %s agent runtime", (name) => {
  const contender = contenders[name];

  it.live("streams the answer in pieces, then done", () =>
    Effect.gen(function* () {
      const mock = yield* mockModel(
        [ModelStep.Say({ words: ["Hi", " there", ",", " friend"] })],
        0,
      );

      const events = yield* Effect.gen(function* () {
        const agent = yield* AgentRuntime;

        return yield* Stream.runCollect(agent.run(turn));
      }).pipe(
        Effect.provide(contender.runtime(mock, recordingGateway().layer, yield* gatewayMcpUrl)),
      );

      expect(textOf(events)).toContain("Hi there, friend");
      expect(events.filter(AgentEvent.$is("TextDelta")).length).toBeGreaterThan(1);
      expect(events.at(-1)).toEqual(AgentEvent.Done());
    }),
  );

  it.live("stops promptly when the turn is cancelled mid-answer, leaving no process behind", () =>
    Effect.gen(function* () {
      const words = Array.from({ length: 60 }, (_, index) => ` word${index}`);
      const mock = yield* mockModel([ModelStep.Say({ words })], 250);
      const before = Option.map(contender.processPattern, processesMatching);

      const exit = yield* Effect.gen(function* () {
        const agent = yield* AgentRuntime;
        const seen = yield* Queue.unbounded<AgentEvent>();

        const fiber = yield* agent.run(turn).pipe(
          Stream.runForEach((event) => Queue.offer(seen, event)),
          Effect.forkChild,
        );

        yield* Queue.take(seen).pipe(Effect.repeat({ until: AgentEvent.$is("TextDelta") }));

        const started = Date.now();

        const interrupted = yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)));

        expect(Date.now() - started).toBeLessThan(5_000);

        return interrupted;
      }).pipe(
        Effect.provide(contender.runtime(mock, recordingGateway().layer, yield* gatewayMcpUrl)),
      );

      expect(Exit.hasInterrupts(exit)).toBe(true);
      expect(Option.map(contender.processPattern, processesMatching)).toEqual(before);
    }),
  );

  it.live("runs neither env nor a read of /etc/passwd when the model asks it to", () => {
    const gateway = recordingGateway();

    return Effect.gen(function* () {
      const mock = yield* mockModel(
        [
          ModelStep.CallTools({ calls: contender.escape }),
          ModelStep.Say({ words: ["All", " done", "."] }),
        ],
        0,
      );

      const exit = yield* Effect.gen(function* () {
        const agent = yield* AgentRuntime;

        return yield* Stream.runCollect(agent.run(turn));
      }).pipe(
        Effect.provide(contender.runtime(mock, gateway.layer, yield* gatewayMcpUrl)),
        Effect.exit,
      );

      const answer = Exit.match(exit, { onSuccess: textOf, onFailure: () => "" });
      const sentToModel = mock.requests().join("\n");

      expect(Exit.isSuccess(exit) ? "answers" : "fails").toBe(contender.afterEscape);

      if (Exit.isSuccess(exit)) expect(answer).toContain("All done.");
      // A tool that is switched off does not exist for the model, so the CLI never even asks.
      expect(gateway.refusals).toEqual([]);

      expect(answer).not.toContain(canary);
      expect(answer).not.toMatch(passwdLine);
      expect(sentToModel).not.toContain(canary);
      expect(sentToModel).not.toMatch(passwdLine);
    });
  });
});
