import { createServer } from "node:http";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, Option } from "effect";
import { FetchHttpClient, HttpMiddleware, HttpRouter } from "effect/http";
import { Otlp } from "effect/observability";
import { browserLayer, destinationsLayer } from "../features/browser/public.ts";
import { computerConfig } from "./config.ts";
import { routesLayer } from "./http.ts";

const computer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* computerConfig;

    const browser = browserLayer(config.home).pipe(
      Layer.provide(destinationsLayer(config.allowPrivateHosts)),
    );

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
      Layer.provide(browser),
      Layer.provide(listener),
      Layer.provide([telemetry, untracedHttp]),
    );
  }),
);

NodeRuntime.runMain(Layer.launch(computer));
