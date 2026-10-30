import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterAll, expect } from "vitest";

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
Lint one fixture file with the installed Oxlint binary and the real `.oxlintrc.json`, rather than
mocking AST nodes. `setup` adds the other files the fixture imports.
*/
export function lint(path: string, code: string, setup?: (root: string) => void): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aobot-lint-")));
  roots.push(root);
  const config = JSON.parse(readFileSync(resolve(project, ".oxlintrc.json"), "utf8"));
  config.jsPlugins = config.jsPlugins.map((plugin: { name: string; specifier: string }) => ({
    ...plugin, specifier: resolve(project, plugin.specifier),
  }));
  fixtureFile(root, ".oxlintrc.json", JSON.stringify(config));
  fixtureFile(root, path, code);
  setup?.(root);
  const result = spawnSync(resolve(project, "node_modules/.bin/oxlint"), ["--format", "default", "--config", join(root, ".oxlintrc.json"), path], {
    cwd: root, encoding: "utf8",
  });
  if (result.error) throw result.error;
  const output = result.stdout + result.stderr;
  expect(output).not.toMatch(/Failed to load|Failed to parse|panicked|Cannot find/u);
  expect([0, 1]).toContain(result.status);
  return output;
}
