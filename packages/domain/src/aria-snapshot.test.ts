import { describe, expect, it } from "vite-plus/test";
import { snapshotRefs } from "./aria-snapshot.ts";

// Captured from Playwright 1.64.1, `page.ariaSnapshot({ mode: "ai" })`, on a sign-up form in Chromium.
const form = `- generic [active] [ref=e1]:
  - heading "Sign up" [level=1] [ref=e2]
  - generic [ref=e3]:
    - generic [ref=e4]:
      - text: Name
      - textbox "Name" [ref=e5]: Ada
    - generic [ref=e6]:
      - text: Email
      - textbox "Email" [ref=e7]
    - generic [ref=e8]:
      - checkbox "Agree" [checked] [ref=e9]
      - text: Agree
    - combobox "Colour" [ref=e10]:
      - option "Red"
      - option "Blue" [selected]
    - textbox "Notes" [ref=e11]: hello
    - button "Send" [ref=e12]
  - list [ref=e13]:
    - listitem [ref=e14]:
      - link "Item \\"quoted\\" link" [ref=e15] [cursor=pointer]:
        - /url: /x
    - listitem [ref=e16]: Plain
  - iframe [ref=e17]:
    - button "Inside" [ref=f1e2]`;

// The same Playwright on names that YAML would misread unquoted.
const quoted = `- generic [active] [ref=e1]:
  - 'button "a: b" [ref=e2]'
  - 'button "it''s #1" [ref=e3]'
  - button "- dash" [ref=e4]
  - button [ref=e5]
  - textbox "x \\"y\\"" [ref=e6]: "v: w"`;

// The top of en.wikipedia.org's main page, as the same Playwright read it.
const wikipedia = `- generic [active] [ref=e1]:
  - link "Jump to content" [ref=e2] [cursor=pointer]:
    - /url: "#bodyContent"
  - banner [ref=e4]:
    - generic [ref=e16]:
      - search [ref=e17]:
        - generic [ref=e20]:
          - searchbox "Search Wikipedia" [active] [ref=e23]: Effect TypeScript
          - button "Search" [ref=e25]`;

describe("snapshotRefs", () => {
  const refs = snapshotRefs(form);

  it("names every element with a ref by its role and name", () => {
    expect(refs.get("e2")).toEqual({ ref: "e2", role: "heading", name: "Sign up" });
    expect(refs.get("e12")).toEqual({ ref: "e12", role: "button", name: "Send" });
    expect(refs.get("e9")).toEqual({ ref: "e9", role: "checkbox", name: "Agree" });
  });

  it("reads a field's value as its value, not its name", () => {
    expect(refs.get("e5")).toEqual({ ref: "e5", role: "textbox", name: "Name" });
    expect(snapshotRefs(wikipedia).get("e23")).toEqual({
      ref: "e23",
      role: "searchbox",
      name: "Search Wikipedia",
    });
  });

  it("gives an element without a name the empty name", () => {
    expect(refs.get("e4")).toEqual({ ref: "e4", role: "generic", name: "" });
    expect(refs.get("e16")).toEqual({ ref: "e16", role: "listitem", name: "" });
  });

  it("keeps refs inside an iframe, which Playwright prefixes with the frame", () => {
    expect(refs.get("f1e2")).toEqual({ ref: "f1e2", role: "button", name: "Inside" });
  });

  it("finds exactly the lines that carry a ref", () => {
    expect([...refs.keys()]).toEqual([
      ...Array.from({ length: 17 }, (_, index) => `e${index + 1}`),
      "f1e2",
    ]);
  });

  it("decodes escaped and YAML-quoted names", () => {
    const names = [...snapshotRefs(quoted).values()].map(({ name }) => name);

    expect(refs.get("e15")?.name).toBe('Item "quoted" link');
    expect(names).toEqual(["", "a: b", "it's #1", "- dash", "", 'x "y"']);
  });

  it("names nothing on a line the cap cut short", () => {
    const cut = snapshotRefs(form.slice(0, form.indexOf("[ref=e12]") + "[ref=e1".length));

    expect(cut.has("e12")).toBe(false);
    expect(cut.has("e1")).toBe(true);
    expect(cut.get("e11")?.name).toBe("Notes");
  });

  it("finds nothing in text that is not a snapshot", () => {
    expect(snapshotRefs("").size).toBe(0);
    expect(snapshotRefs("click e12 please").size).toBe(0);
  });
});
