import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Email, SessionState } from "@aobot/domain";
import { NodeHttpServer } from "@effect/platform-node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { type Context, Effect, Exit, Layer, Option, Schema, Scope } from "effect";
import { HttpRouter } from "effect/http";
import { SqlClient } from "effect/sql";
import { sessionRoute } from "./http.ts";
import { type Claims, Provider } from "./provider.ts";
import { sessionCookie } from "./sessions.ts";
import { returnAddressOf, signInRoutes } from "./sign-in.ts";
import { testAuthDatabase, testSignIn } from "./testing/test-auth.ts";

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

const http = createServer();

const scope = Effect.runSync(Scope.make());

let sql: Context.Context<SqlClient.SqlClient>;

beforeAll(async () => {
  sql = await Effect.runPromise(Layer.buildWithScope(testAuthDatabase, scope));

  const publicUrl = new URL("http://localhost:3100");

  const server = HttpRouter.serve(
    Layer.mergeAll(signInRoutes(publicUrl).pipe(Layer.provide(fakeProvider)), sessionRoute),
    { disableLogger: true, disableListenLog: true },
  ).pipe(
    Layer.provide(testSignIn()),
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

    expect(left.status).toBe(303);
    expect(left.headers.get("location")).toBe("https://login.example.com/auth?state=state-1");
    expect(cookiesOf(left).attributes("aobot_signin")).toMatch(
      /Max-Age=600.*Path=\/auth.*HttpOnly.*SameSite=Lax/u,
    );
  });

  it("lets alice in with a session cookie and sends her back where she was", async () => {
    const back = await signIn("/audit?bot=assistant");
    const { pairs, attributes } = cookiesOf(back);

    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe("http://localhost:3100/audit?bot=assistant");
    expect(attributes(sessionCookie)).toMatch(/Max-Age=604800.*Path=\/;.*HttpOnly.*SameSite=Lax/u);
    expect(await sessionWith(pairs)).toEqual(
      SessionState.cases.SignedIn.make({
        person: { email: Email.make("alice@example.com"), name: "alice" },
      }),
    );
  });

  it("keeps alice on this server when where she was is spelt with dot segments", async () => {
    const back = await signIn("/.//evil.example/phish");

    expect(new URL(back.headers.get("location") ?? "", "http://localhost:3100").origin).toBe(
      "http://localhost:3100",
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

  it("refuses an address only a lookalike of another's, rather than signing that person in", async () => {
    vouched = claimsOf("\u212Aate@example.com");

    const back = await signIn();

    expect(back.headers.get("location")).toBe("/?signin=unsupported_email");
    expect(cookiesOf(back).attributes(sessionCookie)).toBe("");
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

describe("returnAddressOf", () => {
  const publicUrl = new URL("http://localhost:3100");

  /** Where a browser that is sent to `location` from this server lands. */
  const landsAt = (location: string) => new URL(location, publicUrl);

  it.each([
    ["/", "http://localhost:3100/"],
    ["/audit?bot=assistant", "http://localhost:3100/audit?bot=assistant"],
    ["/?c=1#x", "http://localhost:3100/?c=1#x"],
    ["audit", "http://localhost:3100/audit"],
    ["http://someone@localhost:3100/audit", "http://localhost:3100/audit"],
  ])("returns %j to %j", (raw, address) => {
    expect(returnAddressOf(Option.some(raw), publicUrl)).toBe(address);
  });

  it.each([
    "//evil.example",
    "/\\evil.example",
    "/\t/evil.example/x",
    "/\n/evil.example/x",
    "\t//evil.example",
    "https://evil.example",
    "http://localhost:3101/",
    "javascript:alert(1)",
  ])("returns to the root instead of %j", (raw) => {
    expect(returnAddressOf(Option.some(raw), publicUrl)).toBe("http://localhost:3100/");
  });

  it.each([
    "/%09/evil.example",
    "/%2F/evil.example",
    "/%5Cevil.example",
    "/.//evil.example",
    "/..//evil.example",
    "/a/..//evil.example",
    "/%2e//evil.example",
    "http://localhost:3100//evil.example",
  ])("keeps %j on this server", (raw) => {
    expect(landsAt(returnAddressOf(Option.some(raw), publicUrl)).origin).toBe(publicUrl.origin);
  });
});
