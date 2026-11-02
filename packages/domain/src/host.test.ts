import { describe, expect, it } from "vite-plus/test";
import { canonicalHost, originOf, sameOrigin } from "./host.ts";

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

const origins: ReadonlyArray<readonly [string, string, boolean]> = [
  ["https://shop.example/cart?step=2#pay", "https://shop.example/cart", true],
  ["blob:https://shop.example/0b9c6f1e-4c1f-4c3e-9f3a-2f1d5f6e7a8b", "https://shop.example/", true],
  ["https://shop.example:8443/", "https://shop.example/", false],
  ["http://shop.example/", "https://shop.example/", false],
  ["https://shop.example./", "https://shop.example/", false],
  ["https://evil.example/", "https://shop.example/", false],
  ["about:blank", "about:blank", true],
  ["about:blank#top", "about:blank", false],
  ["data:text/html,<p>hi</p>", "data:text/html,<p>bye</p>", false],
  ["", "", false],
  ["https://shop.example/", "", false],
];

describe("sameOrigin", () => {
  it.each(origins)("counts %s on the origin of %s: %s", (now, read, same) => {
    expect(sameOrigin(now, read)).toBe(same);
  });
});

describe("originOf", () => {
  it.each([
    ["https://shop.example/cb?code=abc#access_token=x", "https://shop.example"],
    ["blob:https://shop.example/0b9c6f1e", "https://shop.example"],
    ["http://[::1]:8080/?k=v", "http://[::1]:8080"],
    ["about:blank", "about:blank"],
  ])("keeps of %s only %s", (read, kept) => {
    expect(originOf(read)).toBe(kept);
  });

  it.each(origins)("counts %s on the origin of %s as the whole address does", (now, read, same) => {
    expect(sameOrigin(now, originOf(read))).toBe(same);
  });
});
