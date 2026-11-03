import { describe, expect, it } from "vite-plus/test";
import { reroute } from "./provider.ts";

describe("reroute", () => {
  const issuer = new URL("http://localhost:5556/dex");
  const internal = new URL("http://dex:5556/dex");

  it.each([
    [
      "http://localhost:5556/dex/.well-known/openid-configuration",
      "http://dex:5556/dex/.well-known/openid-configuration",
    ],
    ["http://localhost:5556/dex/token", "http://dex:5556/dex/token"],
    ["http://localhost:5556/dex", "http://dex:5556/dex"],
  ])("sends %s to the issuer's internal address", (url, rerouted) => {
    expect(reroute(url, issuer, internal)).toBe(rerouted);
  });

  it.each([
    "http://localhost:5556/dexter/token",
    "http://localhost:3100/auth/callback",
    "https://evil.example/dex",
  ])("leaves %s alone", (url) => {
    expect(reroute(url, issuer, internal)).toBe(url);
  });
});
