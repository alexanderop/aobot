import { describe, expect, it } from "vite-plus/test";
import { fixtureFile, lint } from "../testing/lint-fixture.ts";
import { featureDependencies, policyProblems, workspaceDependencies } from "./policy.ts";

const doc = "/** Documented. */\n";

/** Create the public entry and one internal module of a feature, so imports resolve. */
function feature(app: string, name: string) {
  return (root: string) => {
    fixtureFile(root, `apps/${app}/src/features/${name}/public.ts`, `${doc}export const x = 1;\n`);
    fixtureFile(
      root,
      `apps/${app}/src/features/${name}/internal.ts`,
      `${doc}export const y = 1;\n`,
    );
  };
}

describe("the declared graphs", () => {
  it("are acyclic and fully registered", () => {
    expect(policyProblems(workspaceDependencies, "workspaces")).toEqual([]);
    for (const [app, graph] of featureDependencies) expect(policyProblems(graph, app)).toEqual([]);
  });

  it("detect a cycle", () => {
    expect(
      policyProblems(
        new Map([
          ["a", ["b"]],
          ["b", ["a"]],
        ]),
        "test",
      ),
    ).toContain("test: dependency cycle a -> b -> a");
  });

  it("let only the gateway reach computers", () => {
    const server = featureDependencies.get("server") ?? new Map<string, readonly string[]>();
    const dependents = [...server]
      .filter(([, deps]) => deps.includes("computers"))
      .map(([name]) => name);
    expect(dependents).toEqual(["gateway"]);
  });
});

describe("aobot architecture enforced by Oxlint", () => {
  it.each([
    [
      "a declared feature dependency through public",
      "apps/server/src/features/gateway/run.ts",
      `import "../computers/public";\n`,
      feature("server", "computers"),
    ],
    [
      "the app layer wiring a feature",
      "apps/server/src/app/main.ts",
      `import "#/features/gateway/public";\n`,
      feature("server", "gateway"),
    ],
    [
      "a feature using shared code",
      "apps/server/src/features/chat/run.ts",
      `import "#/shared/ids";\n`,
      (root: string) =>
        fixtureFile(root, "apps/server/src/shared/ids.ts", `${doc}export const z = 1;\n`),
    ],
    [
      "another workspace by package name",
      "apps/server/src/features/chat/run.ts",
      `import "@aobot/domain";\n`,
      undefined,
    ],
    [
      "Node built-ins in a domain test",
      "packages/domain/src/x.test.ts",
      `import "node:fs";\n`,
      undefined,
    ],
  ])("allows %s", (_name, path, code, setup) => {
    expect(lint(path, code, setup)).not.toContain("aobot-architecture");
  });

  it.each([
    [
      "a feature reaching computers without a declared dependency",
      "apps/server/src/features/chat/run.ts",
      `import "../computers/public";\n`,
      feature("server", "computers"),
      "chat has no declared dependency on computers",
    ],
    [
      "a feature importing another feature's internals",
      "apps/server/src/features/gateway/run.ts",
      `import "../computers/internal";\n`,
      feature("server", "computers"),
      "Import computers/public instead of internal module",
    ],
    [
      "a feature depending on app composition",
      "apps/server/src/features/chat/run.ts",
      `import "#/app/main";\n`,
      (root: string) =>
        fixtureFile(root, "apps/server/src/app/main.ts", `${doc}export const m = 1;\n`),
      "Features cannot depend on app composition",
    ],
    [
      "shared code depending on a feature",
      "apps/server/src/shared/ids.ts",
      `import "#/features/chat/public";\n`,
      feature("server", "chat"),
      "Shared code cannot depend on features",
    ],
    [
      "an unregistered feature",
      "apps/server/src/features/billing/run.ts",
      "export {};\n",
      undefined,
      "Register feature billing of server",
    ],
    [
      "a file outside the known layers",
      "apps/server/src/helpers/x.ts",
      "export {};\n",
      undefined,
      "is not in a known layer",
    ],
    [
      "the web importing the server",
      "apps/web/src/features/chat/run.ts",
      `import "@aobot/server";\n`,
      undefined,
      "web has no declared dependency on workspace server",
    ],
    [
      "a relative import into another workspace",
      "apps/server/src/features/chat/run.ts",
      `import "../../../../web/src/app/main";\n`,
      (root: string) =>
        fixtureFile(root, "apps/web/src/app/main.ts", `${doc}export const m = 1;\n`),
      "Import workspace web as @aobot/web",
    ],
    [
      "a deep workspace import",
      "apps/server/src/features/chat/run.ts",
      `import "@aobot/domain/src/chat-event";\n`,
      undefined,
      "Import @aobot/domain, not its internal path",
    ],
    [
      "Node built-ins in the domain package",
      "packages/domain/src/x.ts",
      `import "node:fs";\n`,
      undefined,
      "no Node built-ins",
    ],
    [
      "React in the domain package",
      "packages/domain/src/x.ts",
      `import "react";\n`,
      undefined,
      "no React or Electron",
    ],
  ])("rejects %s", (_name, path, code, setup, message) => {
    expect(lint(path, code, setup)).toContain(message);
  });
});

describe("restricted globals and properties", () => {
  it.each([
    [
      "process.env in a feature",
      "apps/server/src/features/chat/run.ts",
      `${doc}export const k = process.env.KEY;\n`,
      "Read settings through Effect Config",
    ],
    [
      "console in the server",
      "apps/server/src/features/chat/run.ts",
      `${doc}export function f() { console.log("x"); }\n`,
      "no-console",
    ],
    [
      "Date.now in the policy feature",
      "apps/server/src/features/policy/decide.ts",
      `${doc}export const t = Date.now();\n`,
      "use Effect's Clock",
    ],
    [
      "Math.random in the domain package",
      "packages/domain/src/x.ts",
      `${doc}export const r = Math.random();\n`,
      "pass randomness in",
    ],
  ])("rejects %s", (_name, path, code, message) => {
    expect(lint(path, code)).toContain(message);
  });

  it.each([
    [
      "process.env in a config layer",
      "apps/server/src/app/config.ts",
      `${doc}export const k = process.env.KEY;\n`,
    ],
    [
      "Date.now outside pure modules",
      "apps/server/src/features/chat/run.ts",
      `${doc}export const t = Date.now();\n`,
    ],
  ])("allows %s", (_name, path, code) => {
    expect(lint(path, code)).not.toMatch(/Effect Config|Effect's Clock/u);
  });
});
