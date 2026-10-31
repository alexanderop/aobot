import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { docsRoot } from "./doc-routes.ts";
import icons from "./diagram-icons.json" with { type: "json" };

/** The roles theme.css colours. A node or subgraph in an architecture diagram takes exactly one. */
const roles = new Set([
  "built",
  "external",
  "planned",
  "planned-external",
  "boundary",
  "deployment",
]);

const diagrams = readdirSync(docsRoot, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".md"))
  .flatMap((file) =>
    [...readFileSync(join(docsRoot, file), "utf8").matchAll(/```mermaid\n([\s\S]*?)```/gu)].map(
      ([, source = ""], index) => ({ name: `${file} #${index + 1}`, source }),
    ),
  );

const architectureDiagrams = diagrams.filter(({ source }) => source.includes("fa:fa-"));

function declaredIds(source: string): string[] {
  return [...source.matchAll(/^\s*(?:subgraph\s+)?([\w-]+)\s*[[(]/gmu)].map(([, id = ""]) => id);
}

function roleOf(source: string): Map<string, string[]> {
  const assigned = new Map<string, string[]>();

  for (const [, ids = "", role = ""] of source.matchAll(
    /^\s*class\s+([\w,-]+)\s+([\w-]+)\s*$/gmu,
  )) {
    for (const id of ids.split(",")) assigned.set(id, [...(assigned.get(id) ?? []), role]);
  }

  return assigned;
}

describe("architecture diagrams", () => {
  it("exist, so these checks have something to check", () => {
    expect(architectureDiagrams.length).toBeGreaterThan(0);
  });

  it.each(architectureDiagrams)(
    "$name uses only icons from the subset in diagram-icons.json",
    ({ source }) => {
      const used = [...source.matchAll(/fa:fa-([\w-]+)/gu)].map(([, name = ""]) => name);

      expect(used.filter((name) => !(name in icons.icons))).toEqual([]);
    },
  );

  it.each(architectureDiagrams)("$name gives every node and subgraph one role", ({ source }) => {
    const assigned = roleOf(source);

    const problems = declaredIds(source).flatMap((id) => {
      const given = assigned.get(id) ?? [];

      return given.length === 1 && roles.has(given[0] ?? "")
        ? []
        : [`${id}: ${given.join(", ") || "none"}`];
    });

    expect(problems).toEqual([]);
  });
});
