import { randomBytes } from "node:crypto";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { Control, ControlRpcs } from "@aobot/domain";
import { NodeHttpServer } from "@effect/platform-node";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { Effect, Exit, Layer, Option, Scope, Stream } from "effect";
import { HttpRouter } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { rpcSocket } from "./rpc-socket.ts";

const handlers = ControlRpcs.toLayer(
  ControlRpcs.of({
    "Control.watch": () => Stream.make(Control.cases.Bot.make({})),
    "Control.take": () => Effect.die("unused"),
    "Control.handBack": () => Effect.die("unused"),
    "Control.click": () => Effect.die("unused"),
  }),
);

const http = createServer();

const scope = Effect.runSync(Scope.make());

beforeAll(async () => {
  const server = HttpRouter.serve(
    RpcServer.layer(ControlRpcs).pipe(
      Layer.provide(rpcSocket(Option.some("aobot.example.com"))),
      Layer.provide(RpcSerialization.layerJson),
      Layer.provide(handlers),
    ),
    { disableLogger: true, disableListenLog: true },
  ).pipe(Layer.provide(NodeHttpServer.layer(() => http, { port: 0, host: "127.0.0.1" })));

  await Effect.runPromise(Layer.buildWithScope(server, scope));
});

afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)));

/** The port the server listens on. */
function port(): number {
  // SAFETY: a server listening on a host and port, not a pipe, reports an `AddressInfo`.
  return (http.address() as AddressInfo).port;
}

/** The status a WebSocket handshake to `/rpc` gets, sent with `headers`: 101 when it is upgraded. */
function handshake(headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const sent = request(`http://127.0.0.1:${port()}/rpc`, {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": randomBytes(16).toString("base64"),
        ...headers,
      },
    });

    sent.on("response", (response) => resolve(response.statusCode ?? 0));
    sent.on("upgrade", (_response, socket) => {
      socket.destroy();
      resolve(101);
    });
    sent.on("error", reject);
    sent.end();
  });
}

describe("the RPC socket", () => {
  it.each(["https://evil.example", "null", "http://127.0.0.1:1"])(
    "refuses an upgrade from a page at %s with 403",
    async (origin) => {
      expect(await handshake({ origin })).toBe(403);
    },
  );

  it("refuses a page whose Origin and Host agree on a name that is not this server's", async () => {
    const rebound = `evil.example:${port()}`;

    expect(await handshake({ origin: `http://${rebound}`, host: rebound })).toBe(403);
  });

  it("refuses a name that is not this server's even without an Origin", async () => {
    expect(await handshake({ host: `evil.example:${port()}` })).toBe(403);
  });

  it.each(["127.0.0.1", "localhost", "[::1]"])(
    "upgrades a page this server served at %s",
    async (name) => {
      const host = `${name}:${port()}`;

      expect(await handshake({ origin: `http://${host}`, host })).toBe(101);
    },
  );

  it.each(["cross-site", "same-site"])(
    "refuses a request a browser says another site sent (%s), even without an Origin",
    async (site) => {
      expect(await handshake({ "sec-fetch-site": site })).toBe(403);
    },
  );

  it("upgrades a page this server served that says it is the same origin", async () => {
    const host = `127.0.0.1:${port()}`;

    expect(
      await handshake({ origin: `http://${host}`, host, "sec-fetch-site": "same-origin" }),
    ).toBe(101);
  });

  it("upgrades a page at the public host it was given, and a client that is no page", async () => {
    expect(
      await handshake({ origin: "https://aobot.example.com", host: "aobot.example.com" }),
    ).toBe(101);
    expect(await handshake({})).toBe(101);
  });
});
