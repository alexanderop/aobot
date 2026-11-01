import { createServer, type IncomingMessage, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { text } from "node:stream/consumers";
import { NodeWS } from "@effect/platform-node";
import { Effect, type Schema } from "effect";

/** A node:http server for `handle` on `at` (a free loopback port by default), closed with the scope. */
export function serve(handle: RequestListener, at?: string) {
  return Effect.acquireRelease(
    Effect.callback<{ readonly port: number; readonly server: Server }>((resume) => {
      const server = createServer(handle);

      const listening = () => {
        // SAFETY: a server on a TCP port reports an `AddressInfo`; a socket path has no port to read.
        const port = at === undefined ? (server.address() as AddressInfo).port : 0;
        resume(Effect.succeed({ port, server }));
      };

      if (at === undefined) server.listen(0, "127.0.0.1", listening);
      else server.listen(at, listening);
    }),
    ({ server }) => Effect.sync(() => server.close()),
  );
}

/** The request body as text. */
export function bodyOf(request: IncomingMessage): Promise<string> {
  return text(request);
}

/** Answers with `status` and, when given, `json`. */
export function reply(
  response: Parameters<RequestListener>[1],
  status: number,
  json?: Schema.Json,
): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(json === undefined ? undefined : JSON.stringify(json));
}

interface ScreenConnection {
  readonly authorization: string | undefined;
  open: boolean;
}

/**
A computer's `/stream` on a free loopback port: it accepts every WebSocket, records its `authorization`
header, and sends what the test hands to `send`. `drop` closes every connection, as a computer that goes
away does. After `refuse` it turns every dial away, as a computer that died does; `dials` keeps when each
came, refused or not. Closed with the scope.
*/
export function serveScreen() {
  return Effect.gen(function* () {
    const connections: Array<ScreenConnection> = [];
    const dials: Array<number> = [];
    let refusing = false;
    const sockets = new Set<NodeWS.WebSocket>();
    const upgrades = new NodeWS.WebSocketServer({ noServer: true });
    const { port, server } = yield* serve((_request, response) => reply(response, 404));
    const drop = () => sockets.forEach((ws) => ws.terminate());

    yield* Effect.addFinalizer(() => Effect.sync(drop));

    server.on("upgrade", (request, socket, head) => {
      dials.push(performance.now());

      if (refusing) {
        socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");

        return;
      }

      upgrades.handleUpgrade(request, socket, head, (ws) => {
        const connection: ScreenConnection = {
          authorization: request.headers.authorization,
          open: true,
        };

        connections.push(connection);
        sockets.add(ws);
        ws.on("close", () => {
          connection.open = false;
          sockets.delete(ws);
        });
      });
    });

    return {
      url: `http://127.0.0.1:${port}`,
      connections,
      dials,
      send: (message: string) => sockets.forEach((ws) => ws.send(message)),
      drop,
      refuse: () => {
        refusing = true;
      },
    };
  });
}
