import { Option } from "effect";

/**
Only what an IPv6 address is written in, once lower-cased and without its zone. Anything else, such as `@`,
`/` or a bracket, is URL syntax that would change what `http://[…]/` parses: `x@[::1]/:` would read as
`::1`.
*/
const ipv6Characters = /^[0-9a-f:.]+$/u;

/** `host` as URL writes an IPv6 address, compressed and in hex, or none when it is no IPv6 address. */
function ipv6(host: string): Option.Option<string> {
  if (!host.includes(":") || !ipv6Characters.test(host)) return Option.none();

  return Option.fromNullishOr(URL.parse(`http://[${host}]/`)).pipe(
    Option.map((url) => url.hostname.slice(1, -1)),
  );
}

/**
The IPv4 address an IPv6 address carries in its low 32 bits, when it is written in one of the forms that
reach it: IPv4-mapped (`::ffff:0:0/96`), NAT64 (`64:ff9b::/96`) or the old compatible form (`::/96`).
`address` is compressed and in hex, as {@link ipv6} writes it.
*/
function embeddedIpv4(address: string): Option.Option<string> {
  const [head = "", tail = ""] = address.split("::");
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
The one spelling of a host: lower case, no brackets, zone or root dot, and an IPv6 address that carries
an IPv4 one reduced to it. Every spelling a client would follow to the same place lands on the same
string, so the computer's egress lists and the server's rules have no door in them. Written without
`node:net` because this package also runs in the web page.
*/
export function canonicalHost(host: string): string {
  const name = host
    .toLowerCase()
    .replace(/^\[(.*)\]$/u, "$1")
    .replace(/%.*$/u, "")
    .replace(/\.+$/u, "");

  return Option.match(ipv6(name), {
    onNone: () => name,
    onSome: (address) => Option.getOrElse(embeddedIpv4(address), () => address),
  });
}

/**
Whether `now` is on the origin of `read`, as the computer checks before it acts on a ref: a query, a
fragment or a `blob:` address of that origin is the same site. An opaque origin, such as `about:blank`'s,
is the same only at the same address, and an address that does not parse is on no origin.
*/
export function sameOrigin(now: string, read: string): boolean {
  const [here, there] = [URL.parse(now), URL.parse(read)];

  if (here === null || there === null) return false;

  return here.origin === "null" ? here.href === there.href : here.origin === there.origin;
}

/**
What {@link sameOrigin} needs of the address a page was read at: its origin, or the address itself when
the origin is opaque. Kept in place of the address, whose path, query or fragment can hold a secret, such
as a form sent by GET or an OAuth redirect's `#access_token=…`.
*/
export function originOf(read: string): string {
  const origin = URL.parse(read)?.origin ?? "null";

  return origin === "null" ? read : origin;
}
