import { createServer } from "node:http";
import { ChatRpcs } from "@aobot/domain";
import { NodeFileSystem, NodeHttpServer, NodePath, NodeRuntime } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { FetchHttpClient, HttpMiddleware, HttpRouter, HttpStaticServer } from "effect/http";
import { Otlp } from "effect/observability";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { checkModel, languageModelLayer, layerApi } from "../features/agent/public.ts";
import { botToolkit } from "../features/bots/public.ts";
import { chatLayer, migrateChat } from "../features/chat/public.ts";
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

    const database = Layer.effectDiscard(migrateChat).pipe(
      Layer.provideMerge(SqliteClient.layer({ filename: config.databasePath })),
      Layer.provide(databaseFolder),
    );

    const agent = layerApi(botToolkit, config.limits).pipe(
      Layer.provide(languageModelLayer(config.model)),
      Layer.provide(FetchHttpClient.layer),
    );

    // Off because the handlers name their own spans and `Chat.turn` starts its own trace. The RPC span
    // around each call would only add a second trace of one span.
    const rpc = RpcServer.layer(ChatRpcs, { disableTracing: true }).pipe(
      Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/rpc" })),
      Layer.provide(RpcSerialization.layerJson),
      Layer.provide(chatLayer),
      Layer.provide([agent, database]),
    );

    const webApp = HttpStaticServer.layer({ root: config.webDistDir, spa: true });

    const modelCheck = Layer.effectDiscard(
      checkModel(config.model).pipe(Effect.provide(FetchHttpClient.layer), Effect.forkScoped),
    );

    const listener = NodeHttpServer.layer(createServer, { port: config.port });

    const telemetry = Option.match(config.otlpEndpoint, {
      onNone: () => Layer.empty,
      onSome: (baseUrl) =>
        Otlp.layerJson({ baseUrl, resource: { serviceName: "aobot-server" } }).pipe(
          Layer.provide(FetchHttpClient.layer),
        ),
    });

    // HTTP carries only the web app's files, the health check and the RPC socket. None of it is worth
    // a trace, and the health check every two seconds would bury the turns.
    const untracedHttp = Layer.succeed(HttpMiddleware.TracerDisabledWhen, () => true);

    return HttpRouter.serve(Layer.mergeAll(rpc, webApp)).pipe(
      Layer.merge(modelCheck),
      Layer.provide(listener),
      Layer.provide([telemetry, untracedHttp]),
    );
  }),
);

NodeRuntime.runMain(Layer.launch(server));
