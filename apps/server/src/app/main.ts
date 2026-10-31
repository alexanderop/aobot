import { createServer } from "node:http";
import { ChatRpcs } from "@aobot/domain";
import { NodeFileSystem, NodeHttpServer, NodePath, NodeRuntime } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, FileSystem, Layer, Path } from "effect";
import { FetchHttpClient, HttpRouter, HttpStaticServer } from "effect/http";
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

    const rpc = RpcServer.layer(ChatRpcs).pipe(
      Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/rpc" })),
      Layer.provide(RpcSerialization.layerJson),
      Layer.provide(chatLayer),
      Layer.provide([agent, database]),
    );

    const webApp = HttpStaticServer.layer({ root: config.webDistDir, spa: true });

    const modelCheck = Layer.effectDiscard(
      checkModel(config.model).pipe(Effect.provide(FetchHttpClient.layer), Effect.forkScoped),
    );

    // An agent turn can be quiet for minutes. Node's default requestTimeout (300 s) would cut a
    // streaming response, so it is off; headers still have to arrive within a minute.
    const listener = NodeHttpServer.layer(
      () => createServer({ requestTimeout: 0, headersTimeout: 60_000 }),
      { port: config.port },
    );

    return HttpRouter.serve(Layer.mergeAll(rpc, webApp)).pipe(
      Layer.merge(modelCheck),
      Layer.provide(listener),
    );
  }),
);

NodeRuntime.runMain(Layer.launch(server));
