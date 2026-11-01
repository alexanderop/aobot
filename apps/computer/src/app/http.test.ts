import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import type { AddressInfo, Socket as NetSocket } from "node:net";
import { CommandEnd, type PageAction, ScreenFrame } from "@aobot/domain";
import { NodeHttpServer, NodeWS } from "@effect/platform-node";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { Effect, Exit, Layer, Option, Redacted, Schema, Scope, Stream } from "effect";
import {
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  type HttpServerResponse,
} from "effect/http";
import {
  ActionFailed,
  ActionRefused,
  Browser,
  type WatchedPage,
} from "../features/browser/public.ts";
import { Screencast, screencastLayer } from "../features/screen/public.ts";
import { CommandFailed, Shell } from "../features/shell/public.ts";
import { routesLayer } from "./http.ts";

const token = "computer-token";

const { Exited } = CommandEnd.cases;

const fakeBrowser = Layer.succeed(
  Browser,
  Browser.of({
    act: (action: PageAction) =>
      Effect.gen(function* () {
        if (action.action !== "navigate")
          return yield* new ActionFailed({ message: "Chromium crashed." });

        if (action.url.startsWith("file:")) {
          return yield* new ActionRefused({ message: "Only http and https addresses open." });
        }

        // The span the browser runs in, and its parent, so the test can see the trace the caller sent.
        const span = yield* Effect.orDie(Effect.currentSpan);

        const parent = Option.match(span.parent, {
          onNone: () => "no parent",
          onSome: (outer) => `${outer.traceId}/${outer.spanId}`,
        });

        return {
          action: "navigate",
          url: action.url,
          title: `${span.name} under ${parent}`,
          snapshot: '- heading "Example Domain" [level=1] [ref=e1]',
          truncated: false,
        } as const;
      }),
    pages: Stream.never,
  }),
);

const fakeScreencast = Layer.succeed(Screencast, Screencast.of({ frames: Stream.never }));

const fakeShell = Layer.succeed(
  Shell,
  Shell.of({
    run: (command) =>
      command === "crash"
        ? Effect.fail(new CommandFailed({ message: "bash would not start." }))
        : Effect.succeed({
            action: "run",
            end: Exited.make({ code: 0 }),
            stdout: { text: `${command}\n`, truncated: false },
            stderr: { text: "", truncated: false },
            leftOutputOpen: false,
          }),
  }),
);

const server = "172.18.0.2";

/** Where a request came from: `x-remote-address`, or the server. A test's own requests come from loopback. */
const calledFrom = <E, R>(handle: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    Effect.provideService(
      handle,
      HttpServerRequest.HttpServerRequest,
      request.modify({
        remoteAddress: Option.some(request.headers["x-remote-address"] ?? server),
      }),
    ),
  );

const app = HttpRouter.toWebHandler(
  routesLayer(Redacted.make(token)).pipe(
    Layer.provideMerge(Layer.mergeAll(fakeBrowser, fakeShell, fakeScreencast)),
    Layer.provide(HttpServer.layerServices),
    Layer.provideMerge(Layer.succeed(HttpMiddleware.TracerDisabledWhen, () => true)),
  ),
  { disableLogger: true, middleware: calledFrom },
);

afterAll(() => app.dispose());

function act(body: string, headers: Record<string, string>) {
  return app.handler(
    new Request("http://computer/act", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
  );
}

const navigate = JSON.stringify({ action: "navigate", url: "https://example.com/" });

const bearer = { authorization: `Bearer ${token}` };

describe("GET /health", () => {
  it("answers without a token", async () => {
    const response = await app.handler(new Request("http://computer/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});

describe("POST /act", () => {
  it.each(["127.0.0.1", "::ffff:127.0.0.1", "::1"])(
    "answers 403 to a caller on the computer itself, at %s, even with the token",
    async (address) => {
      const response = await act(navigate, { ...bearer, "x-remote-address": address });
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("");
    },
  );

  it.each([
    ["no token", {}],
    ["the wrong token", { authorization: "Bearer computer-tokeN" }],
    ["a non-ASCII token", { authorization: "Bearer computer-tökén" }],
    ["the token without Bearer", { authorization: token }],
  ])("answers 401 to %s", async (_, headers) => {
    const response = await act(navigate, headers);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Not authorised." });
  });

  it("carries out an action and answers with its result", async () => {
    const response = await act(navigate, bearer);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      action: "navigate",
      url: "https://example.com/",
      title: "Computer.act under no parent",
      snapshot: '- heading "Example Domain" [level=1] [ref=e1]',
      truncated: false,
    });
  });

  it("runs the action inside the caller's trace", async () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const spanId = "00f067aa0ba902b7";
    const response = await act(navigate, { ...bearer, traceparent: `00-${traceId}-${spanId}-01` });
    expect(await response.json()).toMatchObject({
      title: `Computer.act under ${traceId}/${spanId}`,
    });
  });

  it("answers 403 refused when the computer will not try", async () => {
    const response = await act(
      JSON.stringify({ action: "navigate", url: "file:///etc/passwd" }),
      bearer,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      reason: "refused",
      message: "Only http and https addresses open.",
    });
  });

  it("answers 502 failed when the browser fails", async () => {
    const response = await act(JSON.stringify({ action: "snapshot" }), bearer);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ reason: "failed", message: "Chromium crashed." });
  });

  it("runs a command in the shell and answers how it ended", async () => {
    const response = await act(JSON.stringify({ action: "run", command: "echo hi" }), bearer);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      action: "run",
      end: Exited.make({ code: 0 }),
      stdout: { text: "echo hi\n", truncated: false },
      stderr: { text: "", truncated: false },
      leftOutputOpen: false,
    });
  });

  it("answers 502 failed when the shell cannot run a command", async () => {
    const response = await act(JSON.stringify({ action: "run", command: "crash" }), bearer);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ reason: "failed", message: "bash would not start." });
  });

  it.each([
    JSON.stringify({ action: "run" }),
    "not json",
    JSON.stringify({ action: "click" }),
    JSON.stringify({ action: "navigate" }),
  ])("answers 400 to the body %s", async (body) => {
    expect((await act(body, bearer)).status).toBe(400);
  });
});

describe("GET /stream", () => {
  function stream(headers: Record<string, string>) {
    return app.handler(
      new Request("http://computer/stream", {
        headers: { connection: "Upgrade", upgrade: "websocket", ...headers },
      }),
    );
  }

  it.each([
    ["no token", {}],
    ["the wrong token", { authorization: "Bearer computer-tokeN" }],
  ])("answers 401 to %s, before any upgrade", async (_, headers) => {
    const response = await stream(headers);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Not authorised." });
  });

  it.each(["127.0.0.1", "::ffff:127.0.0.1", "::1"])(
    "answers 403 to a caller on the computer itself, at %s, even with the token",
    async (address) => {
      const response = await stream({ ...bearer, "x-remote-address": address });
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("");
    },
  );
});

/** A page whose screencast paints a numbered frame of about `size` bytes every `every` milliseconds. */
function paintingPage(size: number, every: number) {
  let painted = 0;

  const page: WatchedPage = {
    isClosed: () => false,
    onClose: () => () => undefined,
    startScreencast: async (onFrame) => {
      const timer = setInterval(() => {
        painted += 1;
        onFrame(
          Buffer.from(String(painted).padStart(9, "0")).toString("base64") + "A".repeat(size),
        );
      }, every);

      return async () => clearInterval(timer);
    },
  };

  return { page, painted: () => painted };
}

const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(ScreenFrame));

/** The number a frame from {@link paintingPage} was painted with. */
function frameNumber(message: NodeWS.RawData): number {
  // SAFETY: ws hands each text message over as one Buffer, its default `binaryType`.
  const { jpeg } = decodeFrame((message as Buffer).toString());

  return Number(Buffer.from(jpeg.slice(0, 12), "base64").toString());
}

/** The routes on a real loopback port over `page`, with every upgraded connection kept. */
async function computerShowing(page: WatchedPage) {
  const http = createServer();
  const upgraded: Array<NetSocket> = [];
  http.on("upgrade", (_request, socket: NetSocket) => upgraded.push(socket));

  const browser = Layer.succeed(
    Browser,
    Browser.of({
      act: () => Effect.die("unused"),
      pages: Stream.make(page).pipe(Stream.concat(Stream.never)),
    }),
  );

  const computer = HttpRouter.serve(routesLayer(Redacted.make(token)), {
    disableLogger: true,
    disableListenLog: true,
    middleware: calledFrom,
  }).pipe(
    Layer.provide([browser, fakeShell, screencastLayer.pipe(Layer.provide(browser))]),
    Layer.provide(NodeHttpServer.layer(() => http, { port: 0, host: "127.0.0.1" })),
    Layer.provide(Layer.succeed(HttpMiddleware.TracerDisabledWhen, () => true)),
  );

  const scope = Effect.runSync(Scope.make());
  await Effect.runPromise(Layer.buildWithScope(computer, scope));
  // SAFETY: a server listening on a host and port, not a pipe, reports an `AddressInfo`.
  const { port } = http.address() as AddressInfo;

  return {
    url: `ws://127.0.0.1:${port}/stream`,
    upgraded,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
}

const frameSize = 100_000;

describe("GET /stream to a viewer that stops reading", () => {
  it("holds one frame at most for it, skips the rest, and sends the latest once it reads again", async () => {
    const { page, painted } = paintingPage(frameSize, 10);
    const computer = await computerShowing(page);
    const viewer = new NodeWS.WebSocket(computer.url, { headers: bearer });
    await new Promise((resolve) => viewer.once("message", resolve));

    viewer.pause();
    await sleep(2_000);

    const held = computer.upgraded[0]?.writableLength ?? 0;
    const resumedAt = painted();

    const fresh = new Promise<void>((resolve) =>
      viewer.on("message", (message) => {
        if (frameNumber(message) > resumedAt) resolve();
      }),
    );

    viewer.resume();
    await fresh;

    viewer.terminate();
    await computer.close();

    expect(held).toBeLessThan(2 * frameSize);
  }, 10_000);
});
