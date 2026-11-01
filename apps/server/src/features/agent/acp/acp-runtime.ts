import {
  Cause,
  Data,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Result,
  Schema,
  Stream,
} from "effect";
import { HttpTraceContext } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Gateway, gatewayMcpName } from "../../gateway/public.ts";
import {
  type AgentEvent,
  AgentRuntime,
  ModelFailed,
  Stalled,
  type Turn,
} from "../agent-runtime.ts";
import { ClientDecision, decideClientRequest } from "./client-requests.ts";
import { type AcpConnection, connect } from "./connection.ts";
import type { AcpLauncher } from "./launchers.ts";
import { promptOutcome, sessionUpdateEvent } from "./session-updates.ts";
import { turnPrompt } from "./turn-prompt.ts";

/** What the `acp` runtime needs: which CLI to start and how, and where the gateway's MCP server is. */
export interface AcpRuntimeOptions {
  /** The CLI's name in audit rows and spans, such as `claude-code`. */
  readonly agent: string;
  readonly launcher: AcpLauncher;
  /** The home folder of the person whose subscription the CLI runs on. */
  readonly home: string;
  readonly gatewayMcpUrl: string;
  readonly stallTimeout: Duration.Duration;
}

/** What reaches a turn from the agent, in the order it happened. */
type Signal = Data.TaggedEnum<{
  Update: { readonly params: Schema.Json };
  Answered: { readonly response: Schema.Json };
  Broken: { readonly failure: ModelFailed };
}>;

const Signal = Data.taggedEnum<Signal>();

const InitializeResponse = Schema.Struct({
  agentInfo: Schema.OptionFromOptionalKey(
    Schema.Struct({ name: Schema.String, version: Schema.String }),
  ),
  agentCapabilities: Schema.OptionFromOptionalKey(
    Schema.Struct({
      mcpCapabilities: Schema.OptionFromOptionalKey(
        Schema.Struct({ http: Schema.OptionFromOptionalKey(Schema.Boolean) }),
      ),
    }),
  ),
});

const NewSessionResponse = Schema.Struct({ sessionId: Schema.String });

/** The agent's answer read as `schema`, or a `ModelFailed` naming what it got wrong. */
function decodeAnswer<S extends Schema.ConstraintDecoder<unknown>>(
  agent: string,
  method: string,
  schema: S,
) {
  const decode = Schema.decodeUnknownEffect(schema);

  return (answer: Schema.Json) =>
    decode(answer).pipe(
      Effect.mapError(
        (error) =>
          new ModelFailed({
            reason: `${agent} answered ${method} in a shape we do not read: ${error.message}`,
          }),
      ),
    );
}

/**
The `acp` runtime: each turn starts the CLI's ACP adapter in its own process group, runs one
`session/prompt` and stops the whole group when the turn ends, however it ends. One process per turn is
what makes "one prompt per ACP session at a time" true: the conversation guard allows one turn, and each
turn has its own session.
*/
export function layerAcp(options: AcpRuntimeOptions) {
  return Layer.effect(
    AgentRuntime,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const gateway = yield* Gateway;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { agent, launcher } = options;

      const stalled = new Stalled({ waitedMs: Duration.toMillis(options.stallTimeout) });

      const ask = <S extends Schema.ConstraintDecoder<unknown>>(
        connection: AcpConnection,
        method: string,
        params: Schema.Json,
        schema: S,
      ) =>
        connection.request(method, params).pipe(
          Effect.timeoutOrElse({
            duration: options.stallTimeout,
            orElse: () => Effect.fail(stalled),
          }),
          Effect.flatMap(decodeAnswer(agent, method, schema)),
        );

      const answerClientRequest = (method: string, params: Schema.Json) =>
        ClientDecision.$match(decideClientRequest(method, params), {
          Refuse: ({ detail, reply }) =>
            gateway.refuse({ agent, action: method, detail }).pipe(Effect.as(reply)),
          Unknown: ({ reply }) => Effect.succeed(reply),
        });

      const signalEvents = Signal.$match({
        Update: ({ params }): Stream.Stream<AgentEvent, ModelFailed> =>
          Option.match(sessionUpdateEvent(params), {
            onNone: () => Stream.empty,
            onSome: (event) => Stream.make(event),
          }),
        Answered: ({ response }) =>
          Result.match(promptOutcome(response), {
            onSuccess: (event) => Stream.make(event),
            onFailure: (failure) => Stream.fail(failure),
          }),
        Broken: ({ failure }) => Stream.fail(failure),
      });

      const startTurn = Effect.fnUntraced(function* (turn: Turn) {
        const folder = yield* fs.makeTempDirectoryScoped({ prefix: "aobot-acp-" });
        const environment = yield* launcher.environment({ folder, home: options.home });

        const handle = yield* spawner.spawn(
          ChildProcess.make(launcher.command, launcher.args, {
            cwd: folder,
            extendEnv: true,
            // The server's own model settings and key are not the CLI's business.
            env: {
              MODEL_PROVIDER: undefined,
              MODEL_NAME: undefined,
              MODEL_API_KEY: undefined,
              MODEL_BASE_URL: undefined,
              ...environment,
            },
            forceKillAfter: "2 seconds",
          }),
        );

        const signals = yield* Queue.unbounded<Signal, Cause.Done>();

        const connection = yield* connect(agent, handle, {
          notification: (method, params) =>
            method === "session/update"
              ? Queue.offer(signals, Signal.Update({ params })).pipe(Effect.asVoid)
              : Effect.void,
          request: answerClientRequest,
        });

        const initialized = yield* ask(
          connection,
          "initialize",
          {
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: { name: "aobot", version: "0.1.0" },
          },
          InitializeResponse,
        );

        yield* Option.match(initialized.agentInfo, {
          onNone: () => Effect.void,
          onSome: (info) =>
            Effect.annotateCurrentSpan({
              "agent.cli.adapter": info.name,
              "agent.cli.version": info.version,
            }),
        });

        const offersHttpMcp = initialized.agentCapabilities.pipe(
          Option.flatMap((capabilities) => capabilities.mcpCapabilities),
          Option.flatMap((mcp) => mcp.http),
          Option.getOrElse(() => false),
        );

        // The CLI sends these on every call to the gateway, so its tool calls land in this turn's trace.
        const traceHeaders = Option.match(yield* Effect.option(Effect.currentSpan), {
          onNone: () => [],
          onSome: (span) => [
            { name: "traceparent", value: HttpTraceContext.toHeaders(span).traceparent },
          ],
        });

        const { sessionId } = yield* ask(
          connection,
          "session/new",
          {
            cwd: folder,
            mcpServers: offersHttpMcp
              ? [
                  {
                    type: "http",
                    name: gatewayMcpName,
                    url: options.gatewayMcpUrl,
                    headers: traceHeaders,
                  },
                ]
              : [],
            _meta: launcher.sessionMeta,
          },
          NewSessionResponse,
        );

        let answered = false;

        // Runs before the process group is stopped: tell the agent first, close its stdin, and give
        // it a moment to read the cancel and exit on its own before the group is signalled.
        yield* Effect.addFinalizer(() =>
          Effect.suspend(() =>
            answered
              ? connection.close
              : connection
                  .notify("session/cancel", { sessionId })
                  .pipe(
                    Effect.andThen(connection.close),
                    Effect.andThen(
                      connection.closedStdout.pipe(Effect.timeout("1 second"), Effect.ignore),
                    ),
                  ),
          ),
        );

        yield* connection
          .request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: turnPrompt(turn) }],
          })
          .pipe(
            Effect.tap(() => Effect.sync(() => (answered = true))),
            Effect.matchEffect({
              onSuccess: (response) => Queue.offer(signals, Signal.Answered({ response })),
              onFailure: (failure) => Queue.offer(signals, Signal.Broken({ failure })),
            }),
            Effect.forkScoped,
          );

        return Stream.fromQueue(signals).pipe(
          Stream.timeoutOrElse({
            duration: options.stallTimeout,
            orElse: () => Stream.fail(stalled),
          }),
          Stream.takeUntil((signal) => !Signal.$is("Update")(signal)),
          Stream.flatMap(signalEvents),
        );
      });

      const run = (turn: Turn) =>
        Stream.unwrap(
          startTurn(turn).pipe(
            Effect.catchTag("PlatformError", (error) =>
              Effect.fail(
                new ModelFailed({ reason: `Could not start ${agent}: ${error.message}` }),
              ),
            ),
          ),
        ).pipe(
          Stream.provideService(Path.Path, path),
          Stream.provideService(FileSystem.FileSystem, fs),
          Stream.withSpan("AgentRuntime.turn", { attributes: { "agent.cli": agent } }),
        );

      return AgentRuntime.of({ run });
    }),
  );
}
