import { describe, expect, it } from "vite-plus/test";
import { Option } from "effect";
import { isAllowedDomain, normalizeEmail } from "./email.ts";

describe("normalizeEmail", () => {
  it.each([
    ["Alice@EXAMPLE.com", "alice@example.com"],
    [" bob@example.com ", "bob@example.com"],
    ["carol@exämple.com", "carol@xn--exmple-cua.com"],
  ])("reads %j as %j", (raw, email) => {
    expect(normalizeEmail(raw)).toEqual(Option.some(email));
  });

  it.each([
    "",
    "alice",
    "@example.com",
    "alice@",
    "al ice@example.com",
    "\u212Aate@example.com",
    "ﬀ@example.com",
    "jürgen@example.com",
  ])("reads %j as no address", (raw) => {
    expect(normalizeEmail(raw)).toEqual(Option.none());
  });
});

describe("isAllowedDomain", () => {
  const alice = Option.getOrThrow(normalizeEmail("alice@example.com"));

  it("lets in an address of an allowed domain", () => {
    expect(isAllowedDomain(alice, ["other.com", "example.com"])).toBe(true);
  });

  it("refuses another domain, a subdomain of an allowed one included", () => {
    expect(isAllowedDomain(alice, ["other.com"])).toBe(false);
    expect(
      isAllowedDomain(Option.getOrThrow(normalizeEmail("a@mail.example.com")), ["example.com"]),
    ).toBe(false);
  });
});
