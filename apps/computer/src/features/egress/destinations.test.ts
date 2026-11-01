import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Result } from "effect";
import { canonicalHost, makeDestinations, parseCidr, reachOf } from "./destinations.ts";
import { DestinationUnreachable } from "./errors.ts";

const dns = new Map([
  ["example.com", ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"]],
  ["intranet.example", ["10.0.0.5"]],
  ["mixed.example", ["93.184.215.14", "169.254.169.254"]],
]);

const fakeResolve = (host: string) =>
  Option.match(Option.fromNullishOr(dns.get(host)), {
    onNone: () => Effect.fail(new DestinationUnreachable({ message: `Could not find ${host}.` })),
    onSome: (addresses) => Effect.succeed(addresses),
  });

describe("parseCidr", () => {
  it("reads address/prefix", () => {
    expect(Result.getOrThrow(parseCidr("10.0.0.0/8"))).toEqual({
      address: "10.0.0.0",
      prefix: 8,
      family: "ipv4",
    });
    expect(Result.getOrThrow(parseCidr("fc00::/7")).family).toBe("ipv6");
  });

  it.each([
    "10.0.0.5/",
    "10.0.0.5",
    "/8",
    "10.0.0.0/33",
    "fc00::/129",
    "example.com/8",
    "10.0.0.0/8/8",
  ])("reads %j as an error, never as /0", (text) => {
    expect(Result.isFailure(parseCidr(text))).toBe(true);
  });
});

describe("canonicalHost", () => {
  it.each([
    ["[::ffff:169.254.169.254]", "169.254.169.254"],
    ["::ffff:a9fe:a9fe", "169.254.169.254"],
    ["64:ff9b::a9fe:a9fe", "169.254.169.254"],
    ["64:ff9b::169.254.169.254", "169.254.169.254"],
    ["METADATA.GOOG.", "metadata.goog"],
    ["[fe80::1%25eth0]", "fe80::1"],
    ["[0:0:0:0:0:0:0:1]", "::1"],
  ])("spells %s as %s", (host, canonical) => {
    expect(canonicalHost(host)).toBe(canonical);
  });
});

describe("reachOf", () => {
  it.each([
    "169.254.169.254",
    "169.254.170.2",
    "100.100.100.200",
    "fd00:ec2::254",
    "metadata.google.internal",
    "metadata.goog",
    "metadata.goog.",
    "64:ff9b::a9fe:a9fe",
    "::ffff:169.254.169.254",
    "[::ffff:a9fe:a9fe]",
    "fe80::1",
  ])("never reaches %s", (host) => {
    expect(reachOf(host)).toBe("never");
  });

  it.each([
    "10.0.0.1",
    "127.0.0.1",
    "172.20.0.3",
    "192.168.65.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "::",
    "fd12:3456::1",
    "::ffff:127.0.0.1",
    "64:ff9b::a00:1",
    "localhost",
    "admin.localhost",
  ])("treats %s as private", (host) => {
    expect(reachOf(host)).toBe("private");
  });

  it.each(["93.184.215.14", "example.com", "2606:4700::1111", "172.32.0.1"])("opens %s", (host) => {
    expect(reachOf(host)).toBe("open");
  });
});

describe("Destinations.check", () => {
  it.effect("returns every address a name resolved to, so only checked ones are connected to", () =>
    Effect.gen(function* () {
      const addresses = yield* makeDestinations(false, fakeResolve).check("example.com");
      expect(addresses).toEqual(dns.get("example.com"));
    }),
  );

  it.effect("returns a literal address in its one spelling, without resolving it", () =>
    Effect.gen(function* () {
      const addresses = yield* makeDestinations(false, fakeResolve).check("[2606:4700:0:0::1111]");
      expect(addresses).toEqual(["2606:4700::1111"]);
    }),
  );
});
