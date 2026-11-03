import { lookup } from "node:dns/promises";
import { BlockList, isIPv4 } from "node:net";
import { Context, Effect, Layer, Schema } from "effect";

/** Who can reach an address: this machine only, the networks it is on, or anyone. */
export type Reach = "loopback" | "private" | "public";

/** The subnets `ranges` names, each as its network address and prefix length. */
function subnets(ranges: ReadonlyArray<readonly [string, number]>): BlockList {
  const list = new BlockList();

  for (const [network, prefix] of ranges) {
    list.addSubnet(network, prefix, network.includes(":") ? "ipv6" : "ipv4");
  }

  return list;
}

const loopback = subnets([
  ["127.0.0.0", 8],
  ["::1", 128],
]);

const privateRanges = subnets([
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["100.64.0.0", 10],
  ["169.254.0.0", 16],
  ["fc00::", 7],
  ["fe80::", 10],
]);

/**
Who can reach the IP address `address`. An IPv4 address written as IPv6 counts as itself; anything that is
neither loopback nor private, the unspecified address included, is public.
*/
export function reachOf(address: string): Reach {
  const unwrapped = address.replace(/^::ffff:/iu, "");
  const family = isIPv4(unwrapped) ? "ipv4" : "ipv6";

  if (loopback.check(unwrapped, family)) return "loopback";

  return privateRanges.check(unwrapped, family) ? "private" : "public";
}

/** A name did not resolve. */
export class LookupFailed extends Schema.TaggedError<LookupFailed>()("LookupFailed", {
  message: Schema.String,
}) {}

/** Every address a host name resolves to, so a test resolves a name without DNS. */
export class Lookup extends Context.Service<
  Lookup,
  { readonly all: (host: string) => Effect.Effect<ReadonlyArray<string>, LookupFailed> }
>()("aobot/auth/Lookup") {}

/** {@link Lookup} through the system's resolver, as any other program on this machine would. */
export const lookupLayer = Layer.succeed(
  Lookup,
  Lookup.of({
    all: (host) =>
      Effect.tryPromise({
        try: () => lookup(host, { all: true }),
        catch: (error) => new LookupFailed({ message: String(error) }),
      }).pipe(Effect.map((found) => found.map(({ address }) => address))),
  }),
);

/** Single-user mode is on where someone other than the one person could reach it. */
class SingleUserExposed extends Schema.TaggedError<SingleUserExposed>()("SingleUserExposed", {
  message: Schema.String,
}) {}

/** Whether a server listening on `address` listens on every address of this machine. */
function isUnspecified(address: string): boolean {
  return address === "0.0.0.0" || address === "::";
}

/**
Refuses single-user mode where anyone could reach it: a server that acts for everyone as one person must
only be reachable by that person. It looks at where people open it, `publicUrl`, and where it listens,
`host`, never at how the server was started. A name that does not resolve, or resolves to a public
address, refuses it. A private address warns, naming it, since anyone on that network acts as the one
person, and so does listening on every address. Loopback says nothing.
*/
export const checkSingleUserAddress = Effect.fn("Auth.checkSingleUserAddress")(function* (
  publicUrl: URL,
  host: string,
) {
  const lookup = yield* Lookup;
  const keepHere = "Set HOST=127.0.0.1 to keep it on this machine.";

  /** Every address `name` resolves to, refused when it does not resolve or one of them is public. */
  const resolve = (name: string, where: string, instead: string) => {
    const exposed = (why: string) =>
      new SingleUserExposed({
        message: `SINGLE_USER=true lets anyone who reaches ${where} act as the one person, and ${why}. ${instead}`,
      });

    return lookup.all(name).pipe(
      Effect.mapError(() => exposed(`${name} does not resolve, so who reaches it is unknown`)),
      Effect.tap((addresses) => {
        const open = addresses.filter(
          (address) => !isUnspecified(address) && reachOf(address) === "public",
        );

        return open.length > 0
          ? Effect.fail(exposed(`${name} resolves to ${open.join(", ")}, a public address`))
          : Effect.void;
      }),
    );
  };

  const isPrivate = (address: string) => reachOf(address) === "private";

  const opened = yield* resolve(
    publicUrl.hostname.replace(/^\[(.*)\]$/u, "$1"),
    publicUrl.origin,
    "Turn sign-in on instead.",
  );

  const listening = yield* resolve(host, `HOST=${host}`, keepHere);

  const warnings = [
    ...opened
      .filter(isPrivate)
      .map(
        (address) =>
          `SINGLE_USER=true on ${address}: anyone on its network can act as the one person.`,
      ),
    ...(listening.some(isUnspecified)
      ? [
          `SINGLE_USER=true listens on every address of this machine (HOST=${host}), so anyone who reaches it over the network can act as the one person. ${keepHere}`,
        ]
      : listening
          .filter(isPrivate)
          .map(
            (address) =>
              `SINGLE_USER=true listens on ${address} (HOST=${host}), so anyone on its network can act as the one person. ${keepHere}`,
          )),
  ];

  yield* Effect.forEach(warnings, (warning) => Effect.logWarning(warning), { discard: true });
});
