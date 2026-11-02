import { createServer } from "node:http";
import { isIPv6 } from "node:net";
import {
  ApprovalRpcs,
  BotRpcs,
  ChatRpcs,
  ControlRpcs,
  ScreenRpcs,
  SecretRpcs,
} from "@aobot/domain";
import {
  NodeChildProcessSpawner,
  NodeFileSystem,
  NodeHttpServer,
  NodePath,
  NodeRuntime,
  NodeWS,
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
import { auditLogLayer, auditTrailLayer, migrateAudit } from "../features/audit/public.ts";
import { botHandlers, botsFileLayer, botToolkit } from "../features/bots/public.ts";
import { chatLayer, migrateChat } from "../features/chat/public.ts";
import { policyFileLayer } from "../features/policy/public.ts";
import { computersLayer } from "../features/computers/public.ts";
import {
  approvalHandlers,
  botToolHandlers,
  controlHandlers,
  secretHandlers,
  gatewayLayer,
  gatewayMcpLayer,
  migrateGateway,
  screenHandlers,
} from "../features/gateway/public.ts";
import { spanAttributesRedacted } from "../shared/span-redaction.ts";
import { auditRoutes } from "./audit-routes.ts";
import { serverConfig } from "./config.ts";
import { fileRoutes } from "./file-routes.ts";
import { rpcSocket } from "./rpc-socket.ts";

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

    const database = Layer.effectDiscard(
      Effect.all([migrateChat, migrateAudit, migrateGateway]),
    ).pipe(
      Layer.provideMerge(SqliteClient.layer({ filename: config.databasePath })),
      Layer.provide(databaseFolder),
    );

    const ownAddress = isIPv6(config.host) ? `[${config.host}]` : config.host;

    // Read once, so the chat and the gateway know the same Bots with the same grants.
    const bots = botsFileLayer(config.botsFile).pipe(Layer.provide(NodeFileSystem.layer));

    const policy = policyFileLayer(config.rulesFile).pipe(Layer.provide(NodeFileSystem.layer));

    // One Computers for the gateway and the screen: two would start two containers with two tokens.
    const computers = computersLayer(config.computers, { otlpEndpoint: config.otlpEndpoint }).pipe(
      Layer.provide([FetchHttpClient.layer, NodeWS.layerWebSocketConstructor]),
    );

    // One gateway for both runtimes, the MCP server and the control handlers: layers are built once per
    // reference, so there is one door to the computer whoever asks.
    const gateway = gatewayLayer.pipe(
      Layer.provide(auditLogLayer),
      Layer.provide(computers),
      Layer.provide(bots),
      Layer.provide(policy),
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
    const rpc = RpcServer.layer(
      ChatRpcs.merge(BotRpcs, ScreenRpcs, ControlRpcs, SecretRpcs, ApprovalRpcs),
      { disableTracing: true },
    ).pipe(
      Layer.provide(rpcSocket(config.publicHost)),
      Layer.provide(RpcSerialization.layerJson),
      Layer.provide([
        chatLayer,
        botHandlers,
        screenHandlers.pipe(Layer.provide(computers)),
        controlHandlers.pipe(Layer.provide(gateway)),
        secretHandlers.pipe(Layer.provide(gateway)),
        approvalHandlers.pipe(Layer.provide(gateway)),
      ]),
      Layer.provide(runtime.agent),
      Layer.provide(bots),
      Layer.provide(database),
    );

    const files = fileRoutes(config.publicHost).pipe(Layer.provide(gateway));

    const audit = auditRoutes(config.publicHost, config.grafanaUrl).pipe(
      Layer.provide(auditTrailLayer),
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

    // HTTP carries only the web app's files, the health check, the RPC socket, a person's files, the
    // audit trail and the gateway's MCP server. A transfer names its own span; the health check every
    // two seconds would bury the turns.
    const untracedHttp = Layer.succeed(HttpMiddleware.TracerDisabledWhen, () => true);

    return HttpRouter.serve(Layer.mergeAll(rpc, files, audit, webApp, runtime.routes)).pipe(
      Layer.merge(runtime.beside),
      Layer.provide(listener),
      Layer.provide([spanAttributesRedacted.pipe(Layer.provide(telemetry)), untracedHttp]),
    );
  }),
);

NodeRuntime.runMain(Layer.launch(server));
