import { Result } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { fillRefs, refTo } from "./model-script.ts";

const before = `- generic [ref=e1]:
  - searchbox "Search Wikipedia" [ref=e23]`;

const after = `URL: https://en.wikipedia.org/
- generic [ref=f1e1]:
  - searchbox "Search Wikipedia" [active] [ref=f1e23]: Effect
  - button "Search" [ref=f1e25]`;

describe("fillRefs", () => {
  it("fills a ref named by role and name from the latest page, and leaves other inputs alone", () => {
    expect(
      fillRefs({ ref: refTo("searchbox", "Search Wikipedia"), text: "Effect TypeScript" }, [
        "Search Wikipedia for Effect TypeScript.",
        before,
        after,
        "Clicked it.",
      ]),
    ).toEqual(Result.succeed({ ref: "f1e23", text: "Effect TypeScript" }));
  });

  it("says which element no page showed", () => {
    const filled = fillRefs({ ref: refTo("button", "Delete") }, [before]);

    expect(filled).toEqual(
      Result.fail(
        'The script asks for the ref of the button "Delete", but the latest page the model was shown has none.',
      ),
    );
  });

  it("fails a ref asked for before any page was shown", () => {
    expect(Result.isFailure(fillRefs({ ref: refTo("button", "Search") }, ["Hello"]))).toBe(true);
  });
});
