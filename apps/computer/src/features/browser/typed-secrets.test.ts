import { describe, expect, it } from "vite-plus/test";
import { hideTyped, hideTypedInAddress } from "./typed-secrets.ts";

describe("hideTyped", () => {
  it.each([
    ["text that echoes it", "Code 123456 sent", ["123456"], "Code [hidden] sent"],
    ["every place it appears", "123456, again 123456", ["123456"], "[hidden], again [hidden]"],
    [
      "a secret quoted in a snapshot",
      String.raw`- text: "say \"hi\" now"`,
      ['say "hi"'],
      '- text: "[hidden] now"',
    ],
    ["the longer of two secrets whole", "hunter2-long", ["hunter2", "hunter2-long"], "[hidden]"],
    [
      "nothing of a secret shorter than four characters",
      "PIN 123 in 2026",
      ["123"],
      "PIN 123 in 2026",
    ],
    ["nothing when no secret was typed", "Code 123456", [], "Code 123456"],
  ])("hides %s", (_, text, secrets, shown) => {
    expect(hideTyped(text, secrets)).toBe(shown);
  });
});

describe("hideTypedInAddress", () => {
  it.each([
    [
      "a code in the query of a form sent by GET",
      "https://shop.example/verify?code=123456",
      ["123456"],
      "https://shop.example/verify?code=[hidden]",
    ],
    [
      "a secret as a form encodes it",
      "https://shop.example/signed-in?note=p%40ss+w0rd%21",
      ["p@ss w0rd!"],
      "https://shop.example/signed-in?note=[hidden]",
    ],
    [
      "a secret as an address encodes it",
      "https://shop.example/a/p%40ss%20w0rd",
      ["p@ss w0rd"],
      "https://shop.example/a/[hidden]",
    ],
    [
      "the path but never the origin",
      "https://hunter2.example/hunter2",
      ["hunter2"],
      "https://hunter2.example/[hidden]",
    ],
    [
      "the whole address on an opaque origin",
      "data:text/html,hunter2",
      ["hunter2"],
      "data:text/html,[hidden]",
    ],
  ])("hides %s", (_, url, secrets, shown) => {
    expect(hideTypedInAddress(url, secrets)).toBe(shown);
  });
});
