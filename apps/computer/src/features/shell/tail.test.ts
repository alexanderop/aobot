import { describe, expect, it } from "vite-plus/test";
import { outputTail } from "./tail.ts";

function collect(limit: number, pieces: ReadonlyArray<string>) {
  const tail = outputTail(limit);

  for (const piece of pieces) tail.add(piece);

  return tail.read();
}

describe("outputTail", () => {
  it("keeps output within the limit whole", () => {
    expect(collect(11, ["hello", " world"])).toEqual({ text: "hello world", truncated: false });
  });

  it("keeps the end of a long output and says the start was dropped", () => {
    const pieces = Array.from({ length: 1_000 }, (_, index) => `line ${index}\n`);
    const tail = collect(20, pieces);

    expect(tail.truncated).toBe(true);
    expect(tail.text).toHaveLength(20);
    expect(tail.text.endsWith("line 998\nline 999\n")).toBe(true);
  });

  it("says the start was dropped even when the cut fell while the output was still arriving", () => {
    expect(collect(5, ["x".repeat(11)])).toEqual({ text: "xxxxx", truncated: true });
  });
});
