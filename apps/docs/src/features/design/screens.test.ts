import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Option } from "effect";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { docsRoot } from "../../shared/doc-routes.ts";
import { InteractiveScreen } from "./InteractiveScreen.tsx";
import { screenFigure, screenNameOf } from "./screen-figure.ts";
import { isInteractiveName, isScreenName, screens } from "./screens.ts";
import { StaticScreen } from "./StaticScreen.tsx";

const names = Object.keys(screens).filter(isScreenName);

const design = readFileSync(join(docsRoot, "design.md"), "utf8");

describe("given the screens registry", () => {
  describe.each(names)("when drawing %s", (name) => {
    it("renders to markup", () => {
      const element = isInteractiveName(name)
        ? createElement(InteractiveScreen, { name })
        : createElement(StaticScreen, { name });

      expect(renderToStaticMarkup(element)).not.toBe("");
    });
  });
});

describe("given docs/design.md", () => {
  it("places every screen exactly once, and no unknown one", () => {
    const placed = [...design.matchAll(/^\[[^\]]+\]\(screen:([a-z-]+)\)$/gmu)].map(
      (match) => match[1],
    );

    expect([...placed].sort()).toEqual([...names].sort());
  });
});

describe("given a screen link", () => {
  it("reads the screen's name from the screen: scheme only", () => {
    expect(screenNameOf("screen:layout")).toEqual(Option.some("layout"));
    expect(screenNameOf("https://example.com")).toEqual(Option.none());
  });

  it("frames the screen's page with the badge and the caption", () => {
    const figure = screenFigure("sidebar", "The <sidebar>.");

    expect(figure).toContain('src="/screens/sidebar/"');
    expect(figure).toContain("Planned · E2-1 · E3-2");
    expect(figure).toContain("The &lt;sidebar&gt;.");
  });

  it("refuses a name that is not in the registry", () => {
    expect(() => screenFigure("nope", "x")).toThrow("unknown screen");
  });
});
