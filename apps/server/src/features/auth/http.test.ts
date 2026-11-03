import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Control, ControlRpcs, Email, SessionState, SignedOut } from "@aobot/domain";
import { NodeHttpServer } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { type Context, Effect, Exit, Layer, Redacted, Schema, Scope, Stream } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { RpcSerialization, RpcServer, RpcTest } from "effect/rpc";
import { actorId, CurrentActor } from "../../shared/actor.ts";
import { auditLogLayer, migrateAudit } from "../audit/public.ts";
import { sessionRoute, signedInGate, signedInRpc } from "./http.ts";
import { Identity, identitySignIn, sessionCookie } from "./identity.ts";
import { migrateAuth } from "./migrations.ts";
import { People, peopleLayer } from "./people.ts";

const settings = { allowedDomains: ["example.com"] as const, admins: new Set<Email>() };

const shell = join(mkdtempSync(join(tmpdir(), "aobot-shell-")), "index.html");

writeFileSync(shell, "<!doctype html><title>aobot</title>");

const handlers = ControlRpcs.toLayer(
  ControlRpcs.of({
    "Control.watch": () => Stream.make(Control.cases.Bot.make({})),
    "Control.take": () => Effect.die("unused"),
    "Control.handBack": () => Effect.die("unused"),
    "Control.click": () => Effect.die("unused"),
  }),
);

/** A route as any feature's: it answers with the actor it is handled for. */
const whoAsks = (path: HttpRouter.PathInput) =>
  HttpRouter.add(
    "GET",
    path,
    Effect.map(CurrentActor, (actor) => HttpServerResponse.text(actorId(actor))),
  );

const signedIn = Layer.mergeAll(identitySignIn(settings), peopleLayer(settings)).pipe(
  Layer.provide(auditLogLayer),
  Layer.provideMerge(
    Layer.effectDiscard(Effect.all([migrateAudit, migrateAuth])).pipe(
      Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
    ),
  ),
);

const http = createServer();

const scope = Effect.runSync(Scope.make());

let people: Context.Context<People | Identity>;

/** A session cookie of alice's. */
let alices: string;

beforeAll(async () => {
  const context = await Effect.runPromise(Layer.buildWithScope(signedIn, scope));

  const server = HttpRouter.serve(
    Layer.mergeAll(
      signedInGate(shell),
      sessionRoute,
      whoAsks("/files"),
      whoAsks("/audit/rows"),
      HttpRouter.add("GET", "/healthz", HttpServerResponse.text("ok")),
      RpcServer.layer(ControlRpcs).pipe(
        Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/rpc" })),
        Layer.provide([RpcSerialization.layerJson, handlers, signedInRpc]),
      ),
    ),
    { disableLogger: true, disableListenLog: true },
  ).pipe(
    Layer.provide(Layer.succeedContext(context)),
    Layer.provide(NodeHttpServer.layer(() => http, { port: 0, host: "127.0.0.1" })),
  );

  await Effect.runPromise(Layer.buildWithScope(server, scope));

  people = context;

  const { token } = await Effect.runPromise(
    People.use((store) =>
      store.enter({ email: Email.make("alice@example.com"), subject: "a", name: "Alice" }),
    ).pipe(Effect.provide(people)),
  );

  alices = `${sessionCookie}=${Redacted.value(token)}`;
});

afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)));

function url(path: string): string {
  // SAFETY: a server listening on a host and port, not a pipe, reports an `AddressInfo`.
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}${path}`;
}

const decodeSession = Schema.decodeUnknownSync(SessionState);

/** What a person's browser gets when they open `path`, sent as a navigation as a browser sends it. */
function open(path: string): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const sent = request(url(path), {
      headers: { "sec-fetch-mode": "navigate", accept: "text/html" },
    });

    sent.on("response", (response) => {
      const chunks: Array<Buffer> = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
      );
    });
    sent.on("error", reject);
    sent.end();
  });
}

/** The status a WebSocket handshake to `/rpc` gets with `headers`: 101 when it is upgraded. */
function handshake(headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const sent = request(url("/rpc"), {
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

describe("given no session", () => {
  it.each(["/files?path=notes.txt", "/audit/rows"])("refuses %s with 401", async (path) => {
    expect((await fetch(url(path))).status).toBe(401);
  });

  it("refuses the RPC socket's upgrade", async () => {
    expect(await handshake({})).toBe(401);
  });

  it("answers a person opening a page with the web app, which asks them to sign in", async () => {
    const opened = await open("/files?path=notes.txt");

    expect(opened.status).toBe(200);
    expect(opened.body).toContain("<title>aobot</title>");
  });

  it("answers the health check and says nobody is signed in", async () => {
    expect((await fetch(url("/healthz"))).status).toBe(200);
    expect(decodeSession(await (await fetch(url("/auth/session"))).json())).toEqual(
      SessionState.cases.SignedOut.make({}),
    );
  });

  it("refuses with 401 a cookie that is no session's", async () => {
    const forged = await fetch(url("/audit/rows"), {
      headers: { cookie: `${sessionCookie}=${randomBytes(32).toString("base64url")}` },
    });

    expect(forged.status).toBe(401);
  });

  it("refuses an RPC call without a session as SignedOut", async () => {
    const refused = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(ControlRpcs);

          return yield* client["Control.watch"]().pipe(Stream.runCollect, Effect.flip);
        }),
      ).pipe(
        Effect.provide([handlers, signedInRpc.pipe(Layer.provide(Layer.succeedContext(people)))]),
      ),
    );

    expect(refused).toEqual(new SignedOut());
  });
});

describe("given alice's session", () => {
  it("answers every route as alice's", async () => {
    const files = await fetch(url("/files?path=notes.txt"), { headers: { cookie: alices } });

    expect(files.status).toBe(200);
    expect(await files.text()).toBe("alice@example.com");
  });

  it("upgrades the RPC socket", async () => {
    expect(await handshake({ cookie: alices })).toBe(101);
  });

  it("says she is signed in", async () => {
    const session = await fetch(url("/auth/session"), { headers: { cookie: alices } });

    expect(decodeSession(await session.json())).toEqual(
      SessionState.cases.SignedIn.make({
        person: { email: Email.make("alice@example.com"), name: "Alice" },
      }),
    );
  });
});
