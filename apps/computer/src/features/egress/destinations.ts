import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { canonicalHost } from "@aobot/domain";
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
