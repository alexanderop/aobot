import { describe, expect, it } from "vite-plus/test";
import { lint } from "../testing/lint-fixture.ts";

const doc = "/** Documented. */\n";

describe("aobot standards enforced by Oxlint", () => {
  it.each([
    [
      "a non-null assertion",
      "apps/server/src/features/chat/x.ts",
      `${doc}export function f(m: Map<string, number>) { return m.get("a")!; }`,
      "no-unjustified-non-null-assertion",
    ],
    [
      "a SAFETY comment on an unrelated earlier statement",
      "apps/server/src/features/chat/x.ts",
      `${doc}export function f(m: Map<string, number>) {\n  // SAFETY: unrelated.\n  const a = 1;\n  return m.get("a")! + a;\n}`,
      "no-unjustified-non-null-assertion",
    ],
    [
      "an undocumented export",
      "packages/domain/src/x.ts",
      "export const value = 1;",
      "require-export-jsdoc",
    ],
    [
      "a line comment instead of JSDoc",
      "packages/domain/src/x.ts",
      "// Not JSDoc.\nexport type Value = number;",
      "require-export-jsdoc",
    ],
    [
      "`| undefined`",
      "apps/server/src/features/chat/x.ts",
      `${doc}export type Pick = string | undefined;`,
      "no-optional-values",
    ],
    [
      "`| null`",
      "packages/domain/src/x.ts",
      `${doc}export function f(): string | null { return null; }`,
      "no-optional-values",
    ],
    [
      "an optional property",
      "apps/server/src/features/bots/x.ts",
      `${doc}export interface Pick { readonly id?: string }`,
      "no-optional-values",
    ],
    [
      "an optional parameter",
      "apps/server/src/shared/x.ts",
      `${doc}export function f(id?: string) { return id; }`,
      "no-optional-values",
    ],
    [
      "an Effect leaf import",
      "apps/server/src/features/chat/x.test.ts",
      'import * as Arbitrary from "effect/Arbitrary";\n\nvoid Arbitrary;',
      "no-effect-leaf-imports",
    ],
    [
      "instanceof on a tagged error",
      "apps/server/src/features/chat/x.ts",
      `class UsageError extends Error {}\n${doc}export const f = (e: Error) => e instanceof UsageError;`,
      "no-tagged-error-instanceof",
    ],
    [
      "Effect.runPromise in a test",
      "apps/web/src/features/chat/x.test.ts",
      'import { Effect } from "effect";\nimport { it } from "vite-plus/test";\n\nit("a", () => Effect.runPromise(Effect.void));',
      "no-manual-effect-runtime-in-tests",
    ],
    [
      "Effect.runPromise passed to pipe in a test",
      "apps/web/src/features/chat/x.test.ts",
      'import { Effect } from "effect";\nimport { it } from "vite-plus/test";\n\nit("a", () => Effect.void.pipe(Effect.runPromise));',
      "no-manual-effect-runtime-in-tests",
    ],
    [
      "ManagedRuntime.make in a contract suite",
      "apps/server/src/features/agent/x.contract.ts",
      'import { Layer, ManagedRuntime } from "effect";\n\nexport const runtime = ManagedRuntime.make(Layer.empty);',
      "no-manual-effect-runtime-in-tests",
    ],
    [
      "a test declared in a for loop",
      "apps/server/src/features/chat/x.test.ts",
      'import { expect, it } from "vite-plus/test";\n\nfor (const n of [1, 2]) it(`n ${n}`, () => expect(n).toBeGreaterThan(0));',
      "no-test-in-loop",
    ],
    [
      "it.effect declared in a forEach",
      "apps/server/src/features/chat/x.test.ts",
      'import { it } from "@effect/vitest";\nimport { Effect } from "effect";\n\n[1, 2].forEach((n) => it.effect(`n ${n}`, () => Effect.succeed(n)));',
      "no-test-in-loop",
    ],
    [
      "Effect.catchTag",
      "apps/server/src/features/chat/x.ts",
      `import { Effect } from "effect";\n${doc}export const f = (e: Effect.Effect<number, { readonly _tag: "A" }>) => e.pipe(Effect.catchTag("A", () => Effect.succeed(0)));`,
      "prefer-catch-tags",
    ],
    [
      "explicit any",
      "apps/server/src/features/chat/x.ts",
      `${doc}export const f = (x: any) => x;`,
      "no-explicit-any",
    ],
  ])("rejects %s", (_name, path, code, rule) => {
    expect(lint(path, code)).toContain(rule);
  });

  it.each([
    [
      "a non-null assertion under a SAFETY comment",
      "apps/server/src/features/chat/x.ts",
      `${doc}export function f(xs: number[]) {\n  if (xs.length === 0) return 0;\n  // SAFETY: xs is non-empty, checked above.\n  return xs.at(0)!;\n}`,
    ],
    [
      "a non-null assertion in a test",
      "apps/server/src/features/chat/x.test.ts",
      'import { expect, it } from "vite-plus/test";\n\nit("a", () => { expect(new Map([["a", 1]]).get("a")!).toBe(1); });',
    ],
    [
      "optional props in a React component",
      "apps/web/src/features/chat/X.tsx",
      `${doc}export function X({ label }: { label?: string }) { return label; }`,
    ],
    [
      "optional values outside every workspace",
      "tools/x.ts",
      `${doc}export function f(id?: string): string | undefined { return id; }`,
    ],
    ["a documented export", "packages/domain/src/x.ts", `${doc}export const value = 1;`],
    [
      "Effect.runPromise outside a test, at a boundary",
      "apps/web/src/app/x.ts",
      `import { Effect } from "effect";\n${doc}export const start = () => Effect.runPromise(Effect.void);`,
    ],
    [
      "a loop inside a test body",
      "apps/server/src/features/chat/x.test.ts",
      'import { expect, it } from "vite-plus/test";\n\nit("a", () => {\n  for (const n of [1, 2]) expect(n).toBeGreaterThan(0);\n});',
    ],
    [
      "it.each",
      "apps/server/src/features/chat/x.test.ts",
      'import { expect, it } from "vite-plus/test";\n\nit.each([1, 2])("n %i", (n) => expect(n).toBeGreaterThan(0));',
    ],
    [
      "Effect.catchTags",
      "apps/server/src/features/chat/x.ts",
      `import { Effect } from "effect";\n${doc}export const f = (e: Effect.Effect<number, { readonly _tag: "A" }>) => e.pipe(Effect.catchTags({ A: () => Effect.succeed(0) }));`,
    ],
    [
      "a local named Effect with a catchTag method",
      "apps/server/src/features/chat/x.ts",
      `const Effect = { catchTag: (tag: string) => tag };\n${doc}export const f = () => Effect.catchTag("A");`,
    ],
  ])("allows %s", (_name, path, code) => {
    expect(lint(path, code)).not.toContain("aobot-standards");
  });
});
