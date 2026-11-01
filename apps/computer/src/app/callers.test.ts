import { networkInterfaces } from "node:os";
import { Option } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { fromThisComputer } from "./callers.ts";

const ownAddresses = Object.values(networkInterfaces())
  .flat()
  .flatMap((network) => (network === undefined ? [] : [network.address]));

describe("fromThisComputer", () => {
  it.each(["127.0.0.1", "127.0.0.2", "::1", "::ffff:127.0.0.1"])("counts %s", (address) => {
    expect(fromThisComputer(Option.some(address))).toBe(true);
  });

  it.each(ownAddresses)("counts its own interface address %s", (address) => {
    expect(fromThisComputer(Option.some(address))).toBe(true);
  });

  it("counts a request whose address is unknown", () => {
    expect(fromThisComputer(Option.none())).toBe(true);
  });

  it.each(["203.0.113.9", "::ffff:203.0.113.9", "2001:db8::9"])("does not count %s", (address) => {
    expect(fromThisComputer(Option.some(address))).toBe(false);
  });
});
