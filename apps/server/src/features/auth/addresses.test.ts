import { isIP } from "node:net";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Logger, Result } from "effect";
import { checkSingleUserAddress, Lookup, LookupFailed, lookupLayer } from "./addresses.ts";

/** A resolver that knows only `names`, and reads an address as itself. */
function resolving(names: Record<string, ReadonlyArray<string>>) {
  return Layer.succeed(
    Lookup,
    Lookup.of({
      all: (host) =>
        isIP(host) !== 0
          ? Effect.succeed([host])
          : host in names
            ? Effect.succeed(names[host] ?? [])
            : Effect.fail(new LookupFailed({ message: `ENOTFOUND ${host}` })),
    }),
  );
}

/** A resolver that knows `localhost`, as this machine's does. */
const onThisMachine = resolving({ localhost: ["::1", "127.0.0.1"] });

/** The single-user check of `publicUrl` on a server listening on `host`, with every warning it logged. */
function check(publicUrl: string, lookup: Layer.Layer<Lookup>, host = "127.0.0.1") {
  const warnings: Array<string> = [];

  const capture = Logger.make(({ logLevel, message }) => {
    if (logLevel === "Warn") warnings.push(String(message));
  });

  return checkSingleUserAddress(new URL(publicUrl), host).pipe(
    Effect.result,
    Effect.map((result) => ({ result, warnings })),
    Effect.provide([lookup, Logger.layer([capture])]),
  );
}

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

  it.effect.each(["0.0.0.0", "::"])(
    "starts listening on every address with HOST=%s and warns how to keep it on this machine",
    (host) =>
      Effect.gen(function* () {
        const { result, warnings } = yield* check("http://localhost:3100", onThisMachine, host);

        expect(result._tag).toBe("Success");
        expect(warnings).toEqual([
          `SINGLE_USER=true listens on every address of this machine (HOST=${host}), so anyone who reaches it over the network can act as the one person. Set HOST=127.0.0.1 to keep it on this machine.`,
        ]);
      }),
  );

  it.effect("starts listening on a private address and warns, naming it", () =>
    Effect.gen(function* () {
      const { result, warnings } = yield* check(
        "http://localhost:3100",
        onThisMachine,
        "192.168.1.5",
      );

      expect(result._tag).toBe("Success");
      expect(warnings).toEqual([
        "SINGLE_USER=true listens on 192.168.1.5 (HOST=192.168.1.5), so anyone on its network can act as the one person. Set HOST=127.0.0.1 to keep it on this machine.",
      ]);
    }),
  );

  it.effect.each([
    ["a public address", "203.0.113.7"],
    ["a name with a public address", "aobot.example.com"],
    ["a name that does not resolve", "nowhere.example"],
  ])("refuses to listen on %s", ([, host]) =>
    Effect.gen(function* () {
      const { result } = yield* check(
        "http://localhost:3100",
        resolving({ localhost: ["127.0.0.1"], "aobot.example.com": ["203.0.113.7"] }),
        host,
      );

      expect(Result.isFailure(result) ? result.failure.message : "started").toContain(
        `HOST=${host}`,
      );
    }),
  );

  it.effect("listens on this machine and says nothing", () =>
    Effect.gen(function* () {
      const { result, warnings } = yield* check(
        "http://localhost:3100",
        onThisMachine,
        "localhost",
      );

      expect(result._tag).toBe("Success");
      expect(warnings).toEqual([]);
    }),
  );
});
