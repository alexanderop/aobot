import { createServer, type IncomingMessage, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { text } from "node:stream/consumers";
import { Effect, type Schema } from "effect";

/** A node:http server for `handle` on `at` (a free loopback port by default), closed with the scope. */
export function serve(handle: RequestListener, at?: string) {
  return Effect.acquireRelease(
    Effect.callback<{ readonly port: number; readonly close: () => void }>((resume) => {
      const server = createServer(handle);

      const listening = () => {
        // SAFETY: a server on a TCP port reports an `AddressInfo`; a socket path has no port to read.
        const port = at === undefined ? (server.address() as AddressInfo).port : 0;
        resume(Effect.succeed({ port, close: () => server.close() }));
      };

      if (at === undefined) server.listen(0, "127.0.0.1", listening);
      else server.listen(at, listening);
    }),
    (server) => Effect.sync(server.close),
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
