import { describe, expect, it } from "vite-plus/test";
import { tokensMatch } from "./token.ts";

describe("tokensMatch", () => {
  it("accepts the exact token", () => {
    expect(tokensMatch("s3cret-token", "s3cret-token")).toBe(true);
  });

  it.each(["s3cret-tokeN", "s3cret-toke", "s3cret-token ", ""])("refuses %j", (offered) => {
    expect(tokensMatch("s3cret-token", offered)).toBe(false);
  });

  it("refuses a non-ASCII token without throwing", () => {
    expect(tokensMatch("s3cret-token", "s3cret-tökén")).toBe(false);
    expect(tokensMatch("s3cret-token", "🔑".repeat(6))).toBe(false);
  });

  it("compares bytes, so the same UTF-16 length with different bytes is a mismatch", () => {
    expect("é".length).toBe("e".length);
    expect(tokensMatch("caf-e", "caf-é")).toBe(false);
  });

  it("accepts a matching non-ASCII token", () => {
    expect(tokensMatch("schlüssel", "schlüssel")).toBe(true);
  });

  it("matches nothing when no token is configured", () => {
    expect(tokensMatch("", "")).toBe(false);
  });
});
