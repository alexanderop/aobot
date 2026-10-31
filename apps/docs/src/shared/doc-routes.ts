import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { StarlightUserConfig } from "@astrojs/starlight/types";

/** The repository's `docs/` folder. The site renders it in place; there is no second copy. */
export const docsRoot = fileURLToPath(new URL("../../../../docs", import.meta.url));

const repoRoot = dirname(docsRoot);

const repoBlob = "https://github.com/alexanderop/aobot/blob/main";

/** A page's id from its path under `docs/`: lower case, no extension, and a `README.md` names its folder. */
export function docId(path: string): string {
  const parts = path.replace(/\.md$/u, "").toLowerCase().split("/");

  if (parts.at(-1) === "readme") parts.pop();

  return parts.length === 0 ? "index" : parts.join("/");
}

function pageHref(id: string): string {
  return id === "index" ? "/" : `/${id}/`;
}

/**
Where a relative link in a docs file points on the site: the page for a `.md` file under `docs/`, or
the file on GitHub when it sits outside `docs/`. Absolute URLs, anchors and anything else stay as written.
*/
export function siteHref(fromFile: string, url: string): string {
  if (/^(?:[a-z][a-z\d+.-]*:|[#/])/iu.test(url)) return url;

  const hashAt = url.indexOf("#");
  const path = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : url.slice(hashAt);
  const target = resolve(dirname(fromFile), path);
  const inDocs = relative(docsRoot, target);

  if (inDocs.startsWith("..")) return `${repoBlob}/${relative(repoRoot, target)}${hash}`;

  if (inDocs.endsWith(".md")) return `${pageHref(docId(inDocs))}${hash}`;

  if (path.endsWith("/")) return `${pageHref(docId(join(inDocs, "README.md")))}${hash}`;

  return url;
}

function pages(folder: string): Array<{ slug: string }> {
  return readdirSync(join(docsRoot, folder))
    .sort()
    .flatMap((file: string) =>
      file.endsWith(".md") && file !== "README.md" ? [{ slug: docId(join(folder, file)) }] : [],
    );
}

function titleOf(path: string): string {
  const text = readFileSync(join(docsRoot, path), "utf8");

  return /^title:\s*(.+)$/mu.exec(text)?.[1] ?? path;
}

/** The sidebar, read from the folders under `docs/` so a new page or ticket shows up without config. */
export function sidebar(): NonNullable<StarlightUserConfig["sidebar"]> {
  const epics = readdirSync(join(docsRoot, "backlog"), { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? [entry.name] : []))
    .sort();

  return [
    { slug: "index", label: "Start here" },
    { label: "Architecture (arc42)", items: pages("arc42") },
    {
      label: "How we build",
      items: pages("").map((page) =>
        page.slug === "ticket-template" ? { ...page, label: "Ticket template" } : page,
      ),
    },
    {
      label: "Backlog",
      items: [
        { slug: "backlog", label: "Overview" },
        ...epics.map((epic) => ({
          label: titleOf(`backlog/${epic}/README.md`),
          collapsed: true,
          items: [
            { slug: docId(`backlog/${epic}/README.md`), label: "Overview" },
            ...pages(`backlog/${epic}`),
          ],
        })),
        ...pages("backlog"),
      ],
    },
  ];
}
