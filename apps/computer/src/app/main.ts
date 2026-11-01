import { createServer } from "node:http";
import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node";
import { workspaceRoot } from "@aobot/domain";
import { Effect, Layer, Option } from "effect";
import { FetchHttpClient, HttpMiddleware, HttpRouter } from "effect/http";
import { Otlp } from "effect/observability";
import { browserLayer } from "../features/browser/public.ts";
import { commandDestinationsLayer, destinationsLayer } from "../features/egress/public.ts";
import { screencastLayer } from "../features/screen/public.ts";
import { shellLayer } from "../features/shell/public.ts";
import { workspaceLayer } from "../features/workspace/public.ts";
import { computerConfig } from "./config.ts";
import { routesLayer } from "./http.ts";

const computer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* computerConfig;

    const browser = browserLayer(config.home).pipe(
      Layer.provide(destinationsLayer(config.allowPrivateHosts)),
    );

    const shell = shellLayer(config.shell).pipe(
      Layer.provide([commandDestinationsLayer, NodeServices.layer]),
    );

    const workspace = workspaceLayer(workspaceRoot).pipe(Layer.provide(NodeServices.layer));

    // Every address, because the server reaches the computer from another container. Docker publishes
    // no port, so only the computer's own network can connect.
    const listener = NodeHttpServer.layer(createServer, { port: config.port, host: "0.0.0.0" });

    const telemetry = Option.match(config.otlpEndpoint, {
      onNone: () => Layer.empty,
      onSome: (baseUrl) =>
        Otlp.layerJson({ baseUrl, resource: { serviceName: "aobot-computer" } }).pipe(
          Layer.provide(FetchHttpClient.layer),
        ),
    });

    // `/act` names its own `Computer.act` span under the caller's, and the health check every two
    // seconds would bury it under HTTP spans.
    const untracedHttp = Layer.succeed(HttpMiddleware.TracerDisabledWhen, () => true);

    return HttpRouter.serve(routesLayer(config.token)).pipe(
      Layer.provide([browser, shell, workspace, screencastLayer.pipe(Layer.provide(browser))]),
      Layer.provide(listener),
      Layer.provide([telemetry, untracedHttp]),
    );
  }),
);

NodeRuntime.runMain(Layer.launch(computer));
