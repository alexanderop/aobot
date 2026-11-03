import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Email, SessionState } from "@aobot/domain";
import { NodeHttpServer } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { type Context, Effect, Exit, Layer, Option, Schema, Scope } from "effect";
import { HttpRouter } from "effect/http";
import { SqlClient } from "effect/sql";
import { auditLogLayer, migrateAudit } from "../audit/public.ts";
import { sessionRoute } from "./http.ts";
import { identitySignIn, sessionCookie } from "./identity.ts";
import { migrateAuth } from "./migrations.ts";
import { peopleLayer } from "./people.ts";
import { type Claims, Provider, reroute } from "./provider.ts";
import { returnPathOf, signInRoutes } from "./sign-in.ts";

const settings = { allowedDomains: ["example.com"] as const, admins: new Set<Email>() };

/** Who the fake provider vouches for at the next callback. */
let vouched: Claims;

const claimsOf = (email: string, verified = true): Claims => ({
  subject: `sub-${email}`,
  email: Option.some(email),
  emailVerified: verified,
  name: Option.some(email.split("@")[0] ?? email),
});

/** A provider whose login page is at login.example.com and which vouches for whoever `vouched` says. */
const fakeProvider = Layer.succeed(
  Provider,
  Provider.of({
    begin: (returnTo) =>
      Effect.succeed({
        url: new URL("https://login.example.com/auth?state=state-1"),
        pending: { state: "state-1", nonce: "nonce-1", verifier: "verifier-1", returnTo },
      }),
    finish: () => Effect.succeed(vouched),
  }),
);

const database = Layer.effectDiscard(Effect.all([migrateAudit, migrateAuth])).pipe(
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
);

const http = createServer();

const scope = Effect.runSync(Scope.make());

let sql: Context.Context<SqlClient.SqlClient>;

beforeAll(async () => {
  sql = await Effect.runPromise(Layer.buildWithScope(database, scope));

  const publicUrl = new URL("http://localhost:3100");

  const server = HttpRouter.serve(
    Layer.mergeAll(
      signInRoutes(publicUrl).pipe(Layer.provide([fakeProvider, peopleLayer(settings)])),
      sessionRoute.pipe(Layer.provide(identitySignIn(settings))),
    ),
    { disableLogger: true, disableListenLog: true },
  ).pipe(
    Layer.provide(auditLogLayer),
    Layer.provide(Layer.succeedContext(sql)),
    Layer.provide(NodeHttpServer.layer(() => http, { port: 0, host: "127.0.0.1" })),
  );

  await Effect.runPromise(Layer.buildWithScope(server, scope));
});

beforeEach(() => {
  vouched = claimsOf("alice@example.com");
});

afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)));

function url(path: string): string {
  // SAFETY: a server listening on a host and port, not a pipe, reports an `AddressInfo`.
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}${path}`;
}

/** `path` asked for with `cookies`, its redirect not followed. */
function get(path: string, cookies: ReadonlyArray<string> = [], method = "GET") {
  return fetch(url(path), { method, redirect: "manual", headers: { cookie: cookies.join("; ") } });
}

/** The `name=value` of each cookie `response` sets, and the attributes of each by its name. */
function cookiesOf(response: Response) {
  const set = response.headers.getSetCookie();

  return {
    pairs: set.map((cookie) => cookie.split(";", 1)[0] ?? ""),
    attributes: (name: string) => set.find((cookie) => cookie.startsWith(`${name}=`)) ?? "",
  };
}

/** Signs in through the routes as whoever the provider vouches for, returning the callback's answer. */
async function signIn(returnTo = "/") {
  const left = await get(`/auth/sign-in?return=${encodeURIComponent(returnTo)}`);

  return get("/auth/callback?code=code-1&state=state-1", cookiesOf(left).pairs);
}

const decodeSession = Schema.decodeUnknownSync(SessionState);

/** Who the page is open for, with `cookies`. */
async function sessionWith(cookies: ReadonlyArray<string>) {
  return decodeSession(await (await get("/auth/session", cookies)).json());
}

/** The reason of the last `auth.refused` row. */
const lastRefusal = () =>
  Effect.runPromise(
    SqlClient.SqlClient.use(
      (client) =>
        client`
        SELECT actor_id, json_extract(detail, '$.reason') AS reason FROM audit_rows
        WHERE action = 'auth.refused' ORDER BY seq DESC LIMIT 1
      `,
    ).pipe(Effect.provide(sql)),
  );

describe("signing in", () => {
  it("sends the browser to the provider, remembering the sign-in in a short-lived cookie", async () => {
    const left = await get("/auth/sign-in?return=/audit");

    expect(left.status).toBe(302);
    expect(left.headers.get("location")).toBe("https://login.example.com/auth?state=state-1");
    expect(cookiesOf(left).attributes("aobot_signin")).toMatch(
      /Max-Age=600.*Path=\/auth.*HttpOnly.*SameSite=Lax/u,
    );
  });

  it("lets alice in with a session cookie and sends her back where she was", async () => {
    const back = await signIn("/audit?bot=assistant");
    const { pairs, attributes } = cookiesOf(back);

    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe("/audit?bot=assistant");
    expect(attributes(sessionCookie)).toMatch(/Max-Age=604800.*Path=\/;.*HttpOnly.*SameSite=Lax/u);
    expect(await sessionWith(pairs)).toEqual(
      SessionState.cases.SignedIn.make({
        person: { email: Email.make("alice@example.com"), name: "alice" },
      }),
    );
  });

  it("refuses mallory@other.com, with no session", async () => {
    vouched = claimsOf("mallory@other.com");

    const back = await signIn();

    expect(back.headers.get("location")).toBe("/?signin=domain");
    expect(cookiesOf(back).attributes(sessionCookie)).toBe("");
    expect(await lastRefusal()).toEqual([
      { actor_id: "mallory@other.com", reason: "domain not allowed" },
    ]);
  });

  it("refuses an address the provider did not verify", async () => {
    vouched = claimsOf("alice@example.com", false);

    expect((await signIn()).headers.get("location")).toBe("/?signin=no_verified_email");
  });

  it("refuses a callback that belongs to no sign-in in flight, or to another one", async () => {
    const without = await get("/auth/callback?code=code-1&state=state-1");

    const forged = await get("/auth/callback?code=code-1&state=state-2", [
      cookiesOf(await get("/auth/sign-in")).pairs.join("; "),
    ]);

    expect(without.headers.get("location")).toBe("/?signin=expired");
    expect(forged.headers.get("location")).toBe("/?signin=expired");
    expect(await lastRefusal()).toEqual([{ actor_id: "anonymous", reason: "expired" }]);
  });

  it("says so when the person cancelled at the provider, keeping only so much of what it said", async () => {
    const back = await get("/auth/callback?error=access_denied&state=state-1");
    await get(`/auth/callback?error=${"x".repeat(5_000)}`);

    const [last] = await Effect.runPromise(
      SqlClient.SqlClient.use(
        (client) => client`
          SELECT length(json_extract(detail, '$.error')) AS kept FROM audit_rows
          WHERE action = 'auth.refused' ORDER BY seq DESC LIMIT 1
        `,
      ).pipe(Effect.provide(sql)),
    );

    expect(back.headers.get("location")).toBe("/?signin=provider");
    expect(Number(last?.["kept"])).toBeLessThan(300);
  });

  it("ends the session on sign-out", async () => {
    const { pairs } = cookiesOf(await signIn());

    const out = await get("/auth/sign-out", pairs, "POST");

    expect(out.status).toBe(303);
    expect(cookiesOf(out).attributes(sessionCookie)).toContain("Max-Age=0");
    expect(await sessionWith(pairs)).toEqual(SessionState.cases.SignedOut.make({}));
  });
});

describe("returnPathOf", () => {
  it.each(["/", "/audit?bot=assistant", "/?c=1#x"])("returns to %s", (path) => {
    expect(returnPathOf(Option.some(path))).toBe(path);
  });

  it.each(["//evil.example", "/\\evil.example", "https://evil.example", "evil", ""])(
    "returns to / instead of %j",
    (path) => {
      expect(returnPathOf(Option.some(path))).toBe("/");
    },
  );
});

describe("reroute", () => {
  const issuer = new URL("http://localhost:5556/dex");
  const internal = new URL("http://dex:5556/dex");

  it.each([
    [
      "http://localhost:5556/dex/.well-known/openid-configuration",
      "http://dex:5556/dex/.well-known/openid-configuration",
    ],
    ["http://localhost:5556/dex/token", "http://dex:5556/dex/token"],
    ["http://localhost:5556/dex", "http://dex:5556/dex"],
  ])("sends %s to the issuer's internal address", (url, rerouted) => {
    expect(reroute(url, issuer, internal)).toBe(rerouted);
  });

  it.each([
    "http://localhost:5556/dexter/token",
    "http://localhost:3100/auth/callback",
    "https://evil.example/dex",
  ])("leaves %s alone", (url) => {
    expect(reroute(url, issuer, internal)).toBe(url);
  });
});
