import { describe, expect, it } from "vite-plus/test";
import { Option } from "effect";
import { admission } from "./admission.ts";
import { normalizeEmail } from "./email.ts";

describe("normalizeEmail", () => {
  it.each([
    ["Alice@EXAMPLE.com", "alice@example.com"],
    [" bob@example.com ", "bob@example.com"],
    ["carol@exämple.com", "carol@xn--exmple-cua.com"],
  ])("reads %j as %j", (raw, email) => {
    expect(normalizeEmail(raw)).toEqual(Option.some(email));
  });

  it.each(["", "alice", "@example.com", "alice@", "al ice@example.com"])(
    "reads %j as no address",
    (raw) => {
      expect(normalizeEmail(raw)).toEqual(Option.none());
    },
  );
});

describe("admission", () => {
  const alice = Option.getOrThrow(normalizeEmail("alice@example.com"));

  it("lets in an address of an allowed domain that was not removed", () => {
    expect(admission(alice, ["example.com"], false)).toEqual(Option.none());
  });

  it("refuses another domain, a subdomain of an allowed one included", () => {
    expect(admission(alice, ["other.com"], false)).toEqual(Option.some("domain"));
    expect(
      admission(Option.getOrThrow(normalizeEmail("a@mail.example.com")), ["example.com"], false),
    ).toEqual(Option.some("domain"));
  });

  it("refuses an address that was removed", () => {
    expect(admission(alice, ["example.com"], true)).toEqual(Option.some("removed"));
  });
});
