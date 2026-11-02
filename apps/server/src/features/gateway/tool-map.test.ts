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

  /** The allow row each tool's row of the table names, and the outcomes it settles as. */
  const audited = {
    navigate: ["navigate", "`succeeded`, `failed` or `unknown`"],
    snapshot: ["snapshot", "`succeeded`, `failed` or `unknown`"],
    click: ["click", "`succeeded`, `failed` or `unknown`"],
    type: ["type", "`succeeded`, `failed` or `unknown`"],
    press: ["press", "`succeeded`, `failed` or `unknown`"],
    run: ["run", "`succeeded`, `failed` or `unknown`"],
    read_file: ["read_file", "`succeeded`, `failed` or `unknown`"],
    write_file: ["write_file", "`succeeded`, `failed` or `unknown`"],
    list_files: ["list_files", "`succeeded`, `failed` or `unknown`"],
    request_secret: ["secret.requested", "`succeeded` or `failed`"],
  } satisfies Record<keyof typeof botToolkit.tools, readonly [string, string]>;

  it.each(Object.entries(audited))("gives %s its audit rows", (tool, [action, outcomes]) => {
    const auditRows = rows.find(([name]) => name === `\`${tool}\``)?.at(-1) ?? "";

    expect(auditRows).toContain(`\`${action} · allow\` with \`{ bot`);
    expect(auditRows).toContain(outcomes);
  });
});
