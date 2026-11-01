import { describe, expect, it } from "vite-plus/test";
import { keepFirst, keepLast } from "./text.ts";

describe("keepFirst", () => {
  it("keeps text within the limit whole", () => {
    expect(keepFirst("hello", 5)).toBe("hello");
  });

  it("keeps the start of longer text", () => {
    expect(keepFirst("hello world", 5)).toBe("hello");
  });

  it("stops before an emoji the cut would split", () => {
    expect(keepFirst("ab😀c", 3)).toBe("ab");
  });

  it("keeps an emoji that ends exactly at the limit", () => {
    expect(keepFirst("ab😀c", 4)).toBe("ab😀");
  });
});

describe("keepLast", () => {
  it("keeps text within the limit whole", () => {
    expect(keepLast("hello", 5)).toBe("hello");
  });

  it("keeps the end of longer text", () => {
    expect(keepLast("hello world", 5)).toBe("world");
  });

  it("starts after an emoji the cut would split", () => {
    expect(keepLast("a😀bc", 3)).toBe("bc");
  });

  it("keeps an emoji that starts exactly at the limit", () => {
    expect(keepLast("a😀bc", 4)).toBe("😀bc");
  });
});
