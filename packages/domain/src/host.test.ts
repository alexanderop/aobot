import { describe, expect, it } from "vite-plus/test";
import { canonicalHost } from "./host.ts";

describe("canonicalHost", () => {
  it.each([
    ["[::ffff:169.254.169.254]", "169.254.169.254"],
    ["::ffff:a9fe:a9fe", "169.254.169.254"],
    ["64:ff9b::a9fe:a9fe", "169.254.169.254"],
    ["64:ff9b::169.254.169.254", "169.254.169.254"],
    ["METADATA.GOOG.", "metadata.goog"],
    ["[fe80::1%25eth0]", "fe80::1"],
    ["[0:0:0:0:0:0:0:1]", "::1"],
    ["[::1]", "::1"],
    ["Shop.Example..", "shop.example"],
    ["shop.example", "shop.example"],
    ["x@[::1]/:", "x@[::1]/:"],
    ["[x@[::1]/:]", "x@[::1]/:"],
  ])("spells %s as %s", (host, canonical) => {
    expect(canonicalHost(host)).toBe(canonical);
  });
});
