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
  ])("allows %s", (_name, path, code) => {
    expect(lint(path, code)).not.toContain("aobot-standards");
  });
});
