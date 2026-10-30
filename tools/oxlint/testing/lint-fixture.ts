import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterAll, expect } from "vite-plus/test";
import { lintConfig } from "../config.ts";

const project = fileURLToPath(new URL("../../../", import.meta.url));
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Write one file into a fixture project. */
export function fixtureFile(root: string, path: string, code: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, code);
}

/**
Lint one fixture file with `vp lint` and the real lint config from `tools/oxlint/config.ts`, rather than
mocking AST nodes. `setup` adds the other files the fixture imports.
*/
export function lint(path: string, code: string, setup?: (root: string) => void): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aobot-lint-")));
  roots.push(root);
  fixtureFile(
    root,
    "package.json",
    JSON.stringify({ name: "lint-fixture", private: true, type: "module" }),
  );
  symlinkSync(resolve(project, "node_modules"), join(root, "node_modules"));
  const config = {
    ...lintConfig,
    jsPlugins: lintConfig.jsPlugins.map((plugin) => ({
      ...plugin,
      specifier: plugin.specifier.startsWith(".")
        ? resolve(project, plugin.specifier)
        : fileURLToPath(import.meta.resolve(plugin.specifier)),
    })),
  };
  fixtureFile(root, ".oxlintrc.json", JSON.stringify(config));
  fixtureFile(root, path, code);
  setup?.(root);
  const result = spawnSync(
    resolve(project, "node_modules/.bin/vp"),
    ["lint", "--format", "default", "--config", join(root, ".oxlintrc.json"), path],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  if (result.error) throw result.error;
  const output = result.stdout + result.stderr;
  expect(output).not.toMatch(
    /Failed to load|Failed to parse|panicked|Cannot find|Package not found/u,
  );
  expect([0, 1]).toContain(result.status);
  return output;
}
