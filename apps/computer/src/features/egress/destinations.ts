import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Context, Effect, Layer, Option, Result } from "effect";
import { DestinationRefused, DestinationUnreachable } from "./errors.ts";

/** How far the computer may go to a host: anywhere, only with private hosts allowed, or never. */
export type Reach = "open" | "private" | "never";

/** A range of addresses, parsed from `address/prefix`. */
export interface Subnet {
  readonly address: string;
  readonly prefix: number;
  readonly family: "ipv4" | "ipv6";
}

/** Read `address/prefix`. Anything else, `10.0.0.5/` included, is an error rather than a guess at `/0`. */
export function parseCidr(text: string): Result.Result<Subnet, string> {
  const match = /^([^/]+)\/(\d{1,3})$/u.exec(text);

  if (match === null) return Result.fail(`${text} is not written as address/prefix.`);

  const [, address = "", digits = ""] = match;
  const version = isIP(address);
  const prefix = Number(digits);

  if (version === 0) return Result.fail(`${text} does not start with an IP address.`);

  if (prefix > (version === 4 ? 32 : 128)) return Result.fail(`${text} has too long a prefix.`);

  return Result.succeed({ address, prefix, family: version === 4 ? "ipv4" : "ipv6" });
}

const ranges: ReadonlyArray<readonly [string, Exclude<Reach, "open">]> = [
  // Link-local, where every cloud serves instance metadata and task credentials (169.254.169.254,
  // 169.254.170.2). No local fixture lives here, so allowing private hosts never opens it.
  ["169.254.0.0/16", "never"],
  ["fe80::/10", "never"],
  ["fd00:ec2::254/128", "never"],
  // Alibaba's metadata address, inside the carrier-grade NAT range below.
  ["100.100.100.200/32", "never"],
  ["0.0.0.0/8", "private"],
  ["10.0.0.0/8", "private"],
  ["100.64.0.0/10", "private"],
  ["127.0.0.0/8", "private"],
  ["172.16.0.0/12", "private"],
  ["192.168.0.0/16", "private"],
  ["::/128", "private"],
  ["::1/128", "private"],
  ["fc00::/7", "private"],
];

function blockListOf(reach: Exclude<Reach, "open">): BlockList {
  const list = new BlockList();

  for (const [cidr, rangeReach] of ranges) {
    if (rangeReach !== reach) continue;
    const subnet = Result.getOrThrow(parseCidr(cidr));
    list.addSubnet(subnet.address, subnet.prefix, subnet.family);
  }

  return list;
}

const blocked = { never: blockListOf("never"), private: blockListOf("private") };

const names = new Map<string, Reach>([
  ["metadata.google.internal", "never"],
  ["metadata.goog", "never"],
  ["localhost", "private"],
]);

/**
The IPv4 address an IPv6 address carries in its low 32 bits, when it is written in one of the forms that
reach it: IPv4-mapped (`::ffff:0:0/96`), NAT64 (`64:ff9b::/96`) or the old compatible form (`::/96`).
*/
function embeddedIpv4(address: string): Option.Option<string> {
  // URL compresses the address and spells a dotted tail in hex, so the groups below are always hex.
  const [head = "", tail = ""] = new URL(`http://[${address}]/`).hostname.slice(1, -1).split("::");
  const split = (part: string) => (part === "" ? [] : part.split(":"));
  const known = [...split(head), ...split(tail)];

  const groups = [
    ...split(head),
    ...Array.from({ length: 8 - known.length }, () => "0"),
    ...split(tail),
  ].map((group) => Number.parseInt(group, 16));

  const [a, b, c, d, e, f, high = 0, low = 0] = groups;
  const zeros = a === 0 && b === 0 && c === 0 && d === 0 && e === 0;
  const mapped = zeros && f === 0xffff;
  const nat64 = a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0;
  // `::` and `::1` have the compatible form's zeros too, but are IPv6 addresses in their own right.
  const compatible = zeros && f === 0 && high >> 8 !== 0;

  if (!mapped && !nat64 && !compatible) return Option.none();

  return Option.some([high >> 8, high & 255, low >> 8, low & 255].join("."));
}

/**
The one spelling of a host the lists above are written in: lower case, no brackets, zone or root dot,
and an IPv6 address that carries an IPv4 one reduced to it. Every spelling a client would follow to the
same place has to land on the same string, or the lists have a door in them.
*/
export function canonicalHost(host: string): string {
  const name = host
    .toLowerCase()
    .replace(/^\[(.*)\]$/u, "$1")
    .replace(/%.*$/u, "")
    .replace(/\.+$/u, "");

  if (isIP(name) !== 6) return name;

  return Option.getOrElse(embeddedIpv4(name), () =>
    new URL(`http://[${name}]/`).hostname.slice(1, -1),
  );
}

/** How far the computer may go to `host`, a name or an address in any spelling. */
export function reachOf(host: string): Reach {
  const canonical = canonicalHost(host);
  const version = isIP(canonical);

  if (version === 0) {
    return names.get(canonical) ?? (canonical.endsWith(".localhost") ? "private" : "open");
  }

  const family = version === 4 ? "ipv4" : "ipv6";

  if (blocked.never.check(canonical, family)) return "never";

  return blocked.private.check(canonical, family) ? "private" : "open";
}

const refusals = {
  never: "That address serves cloud credentials, so the computer never opens it.",
  private: "That address is inside the computer's own network, so the computer does not open it.",
};

/** Why the computer may not go to `host`, or none when it may. */
function refusalOf(host: string, allowPrivateHosts: boolean): Option.Option<string> {
  const reach = reachOf(host);

  if (reach === "open" || (reach === "private" && allowPrivateHosts)) return Option.none();

  return Option.some(refusals[reach]);
}

/** Every address a host name resolves to. */
export type Resolve = (
  host: string,
) => Effect.Effect<ReadonlyArray<string>, DestinationUnreachable>;

/** Where the computer may connect. Used for the address a Bot asks for and for every connection after it. */
export class Destinations extends Context.Service<
  Destinations,
  {
    /**
    The addresses `host` may be reached at. A name is resolved once and every address it resolves to is
    checked, so connecting only to these means a second lookup can never point elsewhere.
    */
    readonly check: (
      host: string,
    ) => Effect.Effect<ReadonlyArray<string>, DestinationRefused | DestinationUnreachable>;
  }
>()("aobot/computer/egress/Destinations") {}

/** {@link Destinations} with its resolver passed in, so tests can say what a name resolves to. */
export function makeDestinations(
  allowPrivateHosts: boolean,
  resolve: Resolve,
): Destinations["Service"] {
  const refuseUnless = (host: string) =>
    Option.match(refusalOf(host, allowPrivateHosts), {
      onNone: () => Effect.void,
      onSome: (message) => Effect.fail(new DestinationRefused({ message })),
    });

  const check = Effect.fn("Destinations.check")(function* (host: string) {
    yield* refuseUnless(host);
    const canonical = canonicalHost(host);

    if (isIP(canonical) !== 0) return [canonical];

    const addresses = yield* resolve(canonical);

    if (addresses.length === 0) {
      return yield* new DestinationUnreachable({ message: `${canonical} has no address.` });
    }

    yield* Effect.forEach(addresses, refuseUnless, { discard: true });

    return addresses.map(canonicalHost);
  });

  return { check };
}

/** The system resolver: every address, in the order DNS gave them. */
const systemResolve: Resolve = (host) =>
  Effect.tryPromise({
    try: () => lookup(host, { all: true, order: "verbatim" }),
    catch: () => new DestinationUnreachable({ message: `Could not find ${host}.` }),
  }).pipe(Effect.map((answers) => answers.map((answer) => answer.address)));

/** {@link Destinations} on the system resolver. */
export const destinationsLayer = (allowPrivateHosts: boolean) =>
  Layer.succeed(Destinations, makeDestinations(allowPrivateHosts, systemResolve));

/**
{@link Destinations} for commands: private hosts stay refused even where the browser may open them for a
fixture, because a command speaks any protocol to whatever it reaches, the server's own port included.
*/
export const commandDestinationsLayer = destinationsLayer(false);
