import { BlockList, isIP, isIPv4 } from "node:net";
import { canonicalHost } from "@aobot/domain";

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
Who can reach the IP address `address`, however it is spelt: an IPv4 address written as IPv6 counts as
itself. Anything that is neither loopback nor private, the unspecified address included, is public.
*/
export function reachOf(address: string): Reach {
  const canonical = canonicalHost(address);
  const family = isIPv4(canonical) ? "ipv4" : "ipv6";

  if (loopback.check(canonical, family)) return "loopback";

  return privateRanges.check(canonical, family) ? "private" : "public";
}

/** Whether listening on `address` listens on every address of this machine, however it is spelt. */
export function isEveryAddress(address: string): boolean {
  const canonical = canonicalHost(address);

  return canonical === "0.0.0.0" || canonical === "::";
}

/** The host of `url` in its one spelling: lower case, without brackets, zone or root dot. */
export function bareHost(url: URL): string {
  return canonicalHost(url.hostname);
}

/** Whether `host`, a bare name or address, is this machine: `localhost`, or a loopback address. */
export function onThisMachine(host: string): boolean {
  return host === "localhost" || (isIP(host) !== 0 && reachOf(host) === "loopback");
}
