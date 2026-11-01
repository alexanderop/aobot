import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { botToolkit } from "../bots/public.ts";

const architecture = readFileSync(
  new URL("../../../../../docs/architecture.md", import.meta.url),
  "utf8",
);

/** The rows of the table under `## Gateway tools`, as cells. */
function gatewayToolRows(): ReadonlyArray<ReadonlyArray<string>> {
  const section = architecture.split("\n## Gateway tools\n")[1]?.split("\n## ")[0] ?? "";

  return section
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
}

describe("docs/architecture.md § Gateway tools", () => {
  const rows = gatewayToolRows();
  const documented = rows.map(([tool]) => tool?.replaceAll("`", ""));

  it("lists every tool the gateway accepts, and nothing else", () => {
    expect([...documented].sort()).toEqual(Object.keys(botToolkit.tools).sort());
  });

  it.each(Object.keys(botToolkit.tools))("gives %s its audit rows", (tool) => {
    const auditRows = rows.find(([name]) => name === `\`${tool}\``)?.at(-1) ?? "";

    expect(auditRows).toContain(`\`${tool} · allow\``);
    expect(auditRows).toContain("`succeeded`, `failed` or `unknown`");
  });
});
