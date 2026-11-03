import { signInRefusalWords } from "@aobot/domain";
import { Option } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { refusalOf, signInHref } from "./session.ts";

describe("the sign-in screen", () => {
  it("says why the server refused the last sign-in, in its words", () => {
    expect(refusalOf("?signin=domain")).toEqual(Option.some(signInRefusalWords.domain));
    expect(refusalOf("?signin=removed&c=1")).toEqual(Option.some(signInRefusalWords.removed));
  });

  it("says nothing without a refusal, and something general for one it does not know", () => {
    expect(refusalOf("?c=1")).toEqual(Option.none());
    expect(refusalOf("?signin=constructor")).toEqual(
      Option.some("Sign-in did not work. Try again."),
    );
  });

  it("signs in to come back to the same page, without the last refusal", () => {
    expect(
      signInHref(new URL("http://localhost:3000/audit?person=alice%40example.com&signin=domain")),
    ).toBe(`/auth/sign-in?return=${encodeURIComponent("/audit?person=alice%40example.com")}`);
  });
});
