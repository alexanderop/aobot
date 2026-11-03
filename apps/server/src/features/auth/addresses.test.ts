import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Logger, Result } from "effect";
import { checkSingleUserAddress, Lookup, LookupFailed, lookupLayer, reachOf } from "./addresses.ts";

/** A resolver that knows only `names`. */
function resolving(names: Record<string, ReadonlyArray<string>>) {
  return Layer.succeed(
    Lookup,
    Lookup.of({
      all: (host) =>
        host in names
          ? Effect.succeed(names[host] ?? [])
          : Effect.fail(new LookupFailed({ message: `ENOTFOUND ${host}` })),
    }),
  );
}

/** The single-user check of `publicUrl`, with every warning it logged. */
function check(publicUrl: string, lookup: Layer.Layer<Lookup>) {
  const warnings: Array<string> = [];

  const capture = Logger.make(({ logLevel, message }) => {
    if (logLevel === "Warn") warnings.push(String(message));
  });

  return checkSingleUserAddress(new URL(publicUrl)).pipe(
    Effect.result,
    Effect.map((result) => ({ result, warnings })),
    Effect.provide([lookup, Logger.layer([capture])]),
  );
}

describe("reachOf", () => {
  it.each(["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"])("counts %s as loopback", (ip) =>
    expect(reachOf(ip)).toBe("loopback"),
  );

  it.each([
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.5",
    "100.64.0.1",
    "169.254.169.254",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:192.168.1.5",
  ])("counts %s as private", (ip) => expect(reachOf(ip)).toBe("private"));

  it.each(["203.0.113.7", "172.32.0.1", "8.8.8.8", "0.0.0.0", "::", "2001:db8::1"])(
    "counts %s as public",
    (ip) => expect(reachOf(ip)).toBe("public"),
  );
});

describe("single-user mode at start-up", () => {
  it.effect("refuses a public URL, naming the public address it is reached at", () =>
    Effect.gen(function* () {
      const { result } = yield* check("http://203.0.113.7:3000", lookupLayer);

      expect(Result.isFailure(result) ? result.failure.message : "started").toContain(
        "resolves to 203.0.113.7, a public address",
      );
    }),
  );

  it.effect("starts on 192.168.1.5 and warns, naming it", () =>
    Effect.gen(function* () {
      const { result, warnings } = yield* check("http://192.168.1.5:3000", lookupLayer);

      expect(result._tag).toBe("Success");
      expect(warnings).toEqual([
        "SINGLE_USER=true on 192.168.1.5: anyone on its network can act as the one person.",
      ]);
    }),
  );

  it.effect("starts on this machine and says nothing", () =>
    Effect.gen(function* () {
      const { result, warnings } = yield* check(
        "http://localhost:3100",
        resolving({ localhost: ["::1", "127.0.0.1"] }),
      );

      expect(result._tag).toBe("Success");
      expect(warnings).toEqual([]);
    }),
  );

  it.effect.each([
    ["a name with a public address", { "aobot.example.com": ["203.0.113.7"] }],
    [
      "a name with a private and a public address",
      { "aobot.example.com": ["10.0.0.4", "2001:db8::1"] },
    ],
    ["a name that does not resolve", {}],
  ] as const)("refuses %s", ([, names]) =>
    Effect.gen(function* () {
      const { result, warnings } = yield* check("https://aobot.example.com", resolving(names));

      expect(result._tag).toBe("Failure");
      expect(warnings).toEqual([]);
    }),
  );
});
