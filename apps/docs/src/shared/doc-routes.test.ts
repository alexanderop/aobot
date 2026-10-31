import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { docId, docsRoot, siteHref } from "./doc-routes.ts";

const ticket = join(docsRoot, "backlog/E0-walking-skeleton/E0-1-chat-with-a-bot-locally.md");

describe("docId", () => {
  it("names a page by its lower-case path and a README by its folder", () => {
    expect(docId("arc42/06-runtime-view.md")).toBe("arc42/06-runtime-view");
    expect(docId("backlog/E0-walking-skeleton/README.md")).toBe("backlog/e0-walking-skeleton");
    expect(docId("README.md")).toBe("index");
  });
});

describe("siteHref", () => {
  it("turns a relative link to another docs page into its site route, keeping the anchor", () => {
    expect(siteHref(ticket, "../../arc42/09-architecture-decisions.md#adr-7--fail-closed")).toBe(
      "/arc42/09-architecture-decisions/#adr-7--fail-closed",
    );
    expect(siteHref(ticket, "../../README.md")).toBe("/");
    expect(siteHref(ticket, "../E1-a-computer/")).toBe("/backlog/e1-a-computer/");
  });

  it("sends a link outside docs/ to the file on GitHub", () => {
    expect(siteHref(ticket, "../../../verify/run.ts")).toBe(
      "https://github.com/alexanderop/aobot/blob/main/verify/run.ts",
    );
  });

  it("leaves absolute URLs and anchors alone", () => {
    expect(siteHref(ticket, "https://arc42.org")).toBe("https://arc42.org");
    expect(siteHref(ticket, "#demo")).toBe("#demo");
  });
});
