import { describe, expect, it } from "vite-plus/test";
import { bareHost, onThisMachine, reachOf } from "./reach.ts";

describe("reachOf", () => {
  it.each(["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"])("counts %s as loopback", (ip) =>
    expect(reachOf(ip)).toBe("loopback"),
  );

  it.each([
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.5",
    "100.64.0.1",
    "169.254.169.254",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:192.168.1.5",
  ])("counts %s as private", (ip) => expect(reachOf(ip)).toBe("private"));

  it.each(["203.0.113.7", "172.32.0.1", "8.8.8.8", "0.0.0.0", "::", "2001:db8::1"])(
    "counts %s as public",
    (ip) => expect(reachOf(ip)).toBe("public"),
  );
});

describe("onThisMachine", () => {
  it.each([
    "http://localhost:3000",
    "http://127.0.0.1",
    "http://127.0.0.2:5556",
    "http://[::1]:3000",
    "http://[::ffff:127.0.0.1]",
    "http://LOCALHOST.",
  ])("counts %s as this machine", (url) =>
    expect(onThisMachine(bareHost(new URL(url)))).toBe(true),
  );

  it.each(["http://dex:5556", "http://192.168.1.5", "http://localhost.example.com", "http://[::]"])(
    "counts %s as elsewhere",
    (url) => expect(onThisMachine(bareHost(new URL(url)))).toBe(false),
  );
});
