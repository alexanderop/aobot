import { createServer } from "node:http";
import { isIPv6 } from "node:net";
import { ChatRpcs } from "@aobot/domain";
import {
  NodeChildProcessSpawner,
  NodeFileSystem,
  NodeHttpServer,
  NodePath,
  NodeRuntime,
} from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { FetchHttpClient, HttpMiddleware, HttpRouter, HttpStaticServer } from "effect/http";
import { Otlp } from "effect/observability";
import { RpcSerialization, RpcServer } from "effect/rpc";
import {
  acpAgents,
  AgentRuntimeSettings,
  checkModel,
  languageModelLayer,
  layerAcp,
  layerApi,
} from "../features/agent/public.ts";
import { auditLogLayer, migrateAudit } from "../features/audit/public.ts";
import { botToolkit } from "../features/bots/public.ts";
import { chatLayer, migrateChat } from "../features/chat/public.ts";
import { computersLayer } from "../features/computers/public.ts";
import { botToolHandlers, gatewayLayer, gatewayMcpLayer } from "../features/gateway/public.ts";
import { serverConfig } from "./config.ts";

const server = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* serverConfig;

    // SQLite creates the file but not the folder around it.
    const databaseFolder = Layer.effectDiscard(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.dirname(config.databasePath), { recursive: true });
      }),
    ).pipe(Layer.provide([NodeFileSystem.layer, NodePath.layer]));

    const database = Layer.effectDiscard(Effect.andThen(migrateChat, migrateAudit)).pipe(
      Layer.provideMerge(SqliteClient.layer({ filename: config.databasePath })),
      Layer.provide(databaseFolder),
    );

    const ownAddress = isIPv6(config.host) ? `[${config.host}]` : config.host;

    // One gateway for both runtimes and the MCP server: layers are built once per reference.
    const gateway = gatewayLayer.pipe(
      Layer.provide(auditLogLayer),
      Layer.provide(
        computersLayer(config.computers, { otlpEndpoint: config.otlpEndpoint }).pipe(
          Layer.provide(FetchHttpClient.layer),
        ),
      ),
      Layer.provide(database),
    );

    // Each runtime brings its agent, what runs beside it, and the routes it serves.
    const runtime = AgentRuntimeSettings.$match(config.runtime, {
      Api: ({ model }) => ({
        agent: layerApi(botToolkit, config.limits).pipe(
          Layer.provide(botToolHandlers),
          Layer.provide(gateway),
          Layer.provide(languageModelLayer(model)),
          Layer.provide(FetchHttpClient.layer),
        ),
        beside: Layer.effectDiscard(
          checkModel(model).pipe(Effect.provide(FetchHttpClient.layer), Effect.forkScoped),
        ),
        routes: Layer.empty,
      }),
      Acp: ({ agent, home }) => ({
        agent: layerAcp({
          agent,
          launcher: acpAgents[agent],
          home,
          gatewayMcpUrl: `http://${ownAddress}:${config.port}/mcp`,
          stallTimeout: config.limits.stallTimeout,
        }).pipe(
          Layer.provide(gateway),
          Layer.provide(NodeChildProcessSpawner.layer),
          Layer.provide([NodeFileSystem.layer, NodePath.layer]),
        ),
        beside: Layer.empty,
        routes: gatewayMcpLayer.pipe(Layer.provide(gateway)),
      }),
    });

    // Off because the handlers name their own spans and `Chat.turn` starts its own trace. The RPC span
    // around each call would only add a second trace of one span.
    const rpc = RpcServer.layer(ChatRpcs, { disableTracing: true }).pipe(
      Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/rpc" })),
      Layer.provide(RpcSerialization.layerJson),
      Layer.provide(chatLayer),
      Layer.provide(runtime.agent),
      Layer.provide(database),
    );

    const webApp = HttpStaticServer.layer({ root: config.webDistDir, spa: true });

    const listener = NodeHttpServer.layer(createServer, { port: config.port, host: config.host });

    const telemetry = Option.match(config.otlpEndpoint, {
      onNone: () => Layer.empty,
      onSome: (baseUrl) =>
        Otlp.layerJson({ baseUrl, resource: { serviceName: "aobot-server" } }).pipe(
          Layer.provide(FetchHttpClient.layer),
        ),
    });

    // HTTP carries only the web app's files, the health check, the RPC socket and the gateway's MCP
    // server. None of it is worth a trace, and the health check every two seconds would bury the turns.
    const untracedHttp = Layer.succeed(HttpMiddleware.TracerDisabledWhen, () => true);

    return HttpRouter.serve(Layer.mergeAll(rpc, webApp, runtime.routes)).pipe(
      Layer.merge(runtime.beside),
      Layer.provide(listener),
      Layer.provide([telemetry, untracedHttp]),
    );
  }),
);

NodeRuntime.runMain(Layer.launch(server));
