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

/**
Refuses single-user mode where anyone could reach it: a server that acts for everyone as one person must
only be reachable by that person. Fails when an address `publicUrl`'s host resolves to is public, or when
it does not resolve at all, and warns naming each private one, since anyone on that network acts as the
one person. Loopback says nothing. It looks at the address, never at how the server was started.
*/
export const checkSingleUserAddress = Effect.fn("Auth.checkSingleUserAddress")(function* (
  publicUrl: URL,
) {
  const host = publicUrl.hostname.replace(/^\[(.*)\]$/u, "$1");

  const exposed = (why: string) =>
    new SingleUserExposed({
      message: `SINGLE_USER=true lets anyone who reaches ${publicUrl.origin} act as the one person, and ${why}. Turn sign-in on instead.`,
    });

  const addresses = yield* (yield* Lookup)
    .all(host)
    .pipe(Effect.mapError(() => exposed(`${host} does not resolve, so who reaches it is unknown`)));

  const reaching = (reach: Reach) => addresses.filter((address) => reachOf(address) === reach);
  const open = reaching("public");

  if (open.length > 0) {
    return yield* exposed(`${host} resolves to ${open.join(", ")}, a public address`);
  }

  yield* Effect.forEach(
    reaching("private"),
    (address) =>
      Effect.logWarning(
        `SINGLE_USER=true on ${address}: anyone on its network can act as the one person.`,
      ),
    { discard: true },
  );
});
