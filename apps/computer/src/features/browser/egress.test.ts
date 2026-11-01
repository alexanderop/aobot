import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { Destinations, makeDestinations } from "./destinations.ts";
import {
  decideEgress,
  EgressDecision,
  parseAbsoluteUrl,
  parseAuthority,
  proxyUser,
  startEgressProxy,
} from "./egress.ts";
import { ActionFailed } from "./errors.ts";

const secret = "per-process-secret";

const dns = new Map([
  ["example.com", ["93.184.215.14"]],
  ["rebinding.example", ["93.184.215.14", "10.0.0.5"]],
  ["fixture.test", ["127.0.0.1"]],
]);

const fakeResolve = (host: string) =>
  Option.match(Option.fromNullishOr(dns.get(host)), {
    onNone: () => Effect.fail(new ActionFailed({ message: `Could not find ${host}.` })),
    onSome: (addresses) => Effect.succeed(addresses),
  });

const destinations = (allowPrivateHosts: boolean) =>
  Layer.succeed(Destinations, makeDestinations(allowPrivateHosts, fakeResolve));

const basic = (password: string) =>
  Option.some(`Basic ${Buffer.from(`${proxyUser}:${password}`).toString("base64")}`);

function decide(target: string, authorization = basic(secret), allowPrivateHosts = false) {
  return decideEgress(secret, authorization, parseAuthority(target)).pipe(
    Effect.provide(destinations(allowPrivateHosts)),
  );
}

describe("decideEgress", () => {
  it.effect("connects to the checked addresses of a public host", () =>
    Effect.gen(function* () {
      expect(yield* decide("example.com:443")).toEqual(
        EgressDecision.Connect({ port: 443, addresses: ["93.184.215.14"] }),
      );
    }),
  );

  const unauthorised: ReadonlyArray<readonly [string, Option.Option<string>]> = [
    ["no credentials", Option.none()],
    ["the wrong secret", basic("guess")],
    ["a non-ASCII secret", basic("pér-process-sécret")],
    ["a bearer token", Option.some(`Bearer ${secret}`)],
  ];

  it.effect.each(unauthorised)("challenges a request with %s", ([, authorization]) =>
    Effect.gen(function* () {
      expect((yield* decide("example.com:443", authorization))._tag).toBe("Challenge");
    }),
  );

  it.effect.each([
    ["169.254.169.254:80"],
    ["[64:ff9b::a9fe:a9fe]:80"],
    ["[::ffff:169.254.169.254]:80"],
    ["metadata.goog:80"],
    ["10.0.0.1:80"],
    ["rebinding.example:443"],
  ])("refuses %s", ([target]) =>
    Effect.gen(function* () {
      expect((yield* decide(target))._tag).toBe("Refuse");
    }),
  );

  it.effect("refuses a target it cannot read", () =>
    Effect.gen(function* () {
      expect((yield* decide("example.com"))._tag).toBe("Refuse");
      expect((yield* decide("example.com:70000"))._tag).toBe("Refuse");
    }),
  );

  it.effect("still refuses metadata with private hosts allowed", () =>
    Effect.gen(function* () {
      expect((yield* decide("169.254.169.254:80", basic(secret), true))._tag).toBe("Refuse");
      expect((yield* decide("10.0.0.1:80", basic(secret), true))._tag).toBe("Connect");
    }),
  );

  it.effect("fails a host that does not resolve", () =>
    Effect.gen(function* () {
      expect((yield* decide("nowhere.invalid:443"))._tag).toBe("Fail");
    }),
  );
});

describe("parseAbsoluteUrl", () => {
  it("reads the host and port of a plain proxied request", () => {
    expect(parseAbsoluteUrl("http://[::1]:8080/x")).toEqual(
      Option.some({ host: "::1", port: 8080 }),
    );
    expect(parseAbsoluteUrl("http://example.com/")).toEqual(
      Option.some({ host: "example.com", port: 80 }),
    );
  });

  it("reads nothing from a path or another scheme", () => {
    expect(parseAbsoluteUrl("/relative")).toEqual(Option.none());
    expect(parseAbsoluteUrl("file:///etc/passwd")).toEqual(Option.none());
  });
});

interface Answer {
  readonly status: number;
  readonly body: string;
}

function viaProxy(proxyPort: number, url: string, headers: IncomingHttpHeaders) {
  return Effect.callback<Answer>((resume) => {
    const outbound = request(
      { host: "127.0.0.1", port: proxyPort, path: url, headers },
      (answer) => {
        let body = "";
        answer.setEncoding("utf8");
        answer.on("data", (chunk: string) => (body += chunk));
        answer.on("end", () => resume(Effect.succeed({ status: answer.statusCode ?? 0, body })));
      },
    );

    outbound.end();
  });
}

function tunnelThrough(proxyPort: number, target: string, authorization: string) {
  return Effect.callback<string>((resume) => {
    const socket = connect({ host: "127.0.0.1", port: proxyPort }, () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nproxy-authorization: ${authorization}\r\n\r\n`);
    });

    let received = "";
    let asked = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      received += chunk;

      if (!asked && received.includes("\r\n\r\n") && received.startsWith("HTTP/1.1 200")) {
        asked = true;
        socket.write("GET / HTTP/1.1\r\nhost: fixture.test\r\nconnection: close\r\n\r\n");
      }
    });
    socket.on("close", () => resume(Effect.succeed(received)));
  });
}

const fixture = Effect.acquireRelease(
  Effect.callback<ReturnType<typeof createServer>>((resume) => {
    const server = createServer((_, response) => response.end("fixture page"));
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
  }),
  (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
);

describe("startEgressProxy", () => {
  it.effect("reaches a name through the address it checked, never a second lookup", () =>
    Effect.gen(function* () {
      const site = yield* fixture;
      // SAFETY: a server listening on a host and port, not a pipe, reports an `AddressInfo`.
      const { port } = site.address() as AddressInfo;
      const proxy = yield* startEgressProxy;
      const proxyPort = Number(new URL(proxy.server).port);
      const authorization = `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}`;
      // `fixture.test` exists only in the fake resolver, so the page arrives only if the proxy connected
      // to the address that resolver gave it.
      const url = `http://fixture.test:${port}/`;

      expect(yield* viaProxy(proxyPort, url, { "proxy-authorization": authorization })).toEqual({
        status: 200,
        body: "fixture page",
      });
      expect((yield* viaProxy(proxyPort, url, {})).status).toBe(407);

      const tunnelled = yield* tunnelThrough(proxyPort, `fixture.test:${port}`, authorization);
      expect(tunnelled).toMatch(/^HTTP\/1\.1 200 Connection Established/u);
      expect(tunnelled).toContain("fixture page");
      expect(yield* tunnelThrough(proxyPort, `fixture.test:${port}`, "Basic bm9wZQ==")).toMatch(
        /^HTTP\/1\.1 407/u,
      );
    }).pipe(Effect.provide(destinations(true))),
  );

  it.effect("answers 403 for a private host when private hosts are not allowed", () =>
    Effect.gen(function* () {
      const proxy = yield* startEgressProxy;
      const proxyPort = Number(new URL(proxy.server).port);
      const authorization = `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}`;

      const answer = yield* viaProxy(proxyPort, "http://fixture.test:1/", {
        "proxy-authorization": authorization,
      });

      expect(answer.status).toBe(403);
    }).pipe(Effect.provide(destinations(false))),
  );
});
