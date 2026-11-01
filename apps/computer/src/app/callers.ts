import { BlockList, isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { Option } from "effect";

const loopback = new BlockList();

loopback.addSubnet("127.0.0.0", 8, "ipv4");

loopback.addAddress("::1", "ipv6");

/** `address` as the computer's own interfaces list it: no zone, and an IPv4-mapped address as IPv4. */
function plain(address: string): string {
  return address.replace(/%.*$/u, "").replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/iu, "");
}

/**
Whether a request came from inside this computer: from a loopback address or from one of the addresses
of its own interfaces, read when asked. Everything on the computer shares one network namespace, so this
is what a command connecting to `/act` looks like. A request whose address is unknown counts as one.
*/
export function fromThisComputer(remoteAddress: Option.Option<string>): boolean {
  return Option.match(Option.map(remoteAddress, plain), {
    onNone: () => true,
    onSome: (address) => {
      const version = isIP(address);

      if (version === 0) return true;

      if (loopback.check(address, version === 4 ? "ipv4" : "ipv6")) return true;

      return Object.values(networkInterfaces())
        .flat()
        .some((network) => network !== undefined && plain(network.address) === address);
    },
  });
}
