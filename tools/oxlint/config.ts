import type { ViteUserConfig } from "vite-plus";

/**
aobot's lint rules. `vite.config.ts` uses them for `vp lint` and `vp check`, and the rule tests write
them into fixture projects, so the tests exercise exactly what production runs.
*/
export const lintConfig = {
  ignorePatterns: [
    ".claude/**",
    "tools/oxlint/anti-slop/**",
    "tools/oxlint/aobot-architecture/**",
    "tools/oxlint/aobot-standards/**",
    "tools/oxlint/testing/**",
    "tools/oxlint/config.ts",
  ],
  jsPlugins: [
    {
      name: "anti-slop",
      specifier: "./tools/oxlint/anti-slop/index.ts",
    },
    {
      name: "anti-slop-effect",
      specifier: "./tools/oxlint/anti-slop/effect/index.ts",
    },
    {
      name: "aobot-architecture",
      specifier: "./tools/oxlint/aobot-architecture/index.ts",
    },
    {
      name: "aobot-standards",
      specifier: "./tools/oxlint/aobot-standards/index.ts",
    },
    {
      name: "vite-plus",
      specifier: "vite-plus/oxlint-plugin",
    },
  ],
  rules: {
    "oxc/no-accumulating-spread": "error",
    "typescript/no-explicit-any": "error",
    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-readable-spacing": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
    "anti-slop-effect/no-manual-effect-error-tag": "error",
    "anti-slop-effect/no-manual-tag-comparison": "error",
    "anti-slop-effect/no-manual-tagged-construction": "error",
    "anti-slop-effect/no-service-constructor-imports": "error",
    "anti-slop-effect/prefer-effect-match": "error",
    "aobot-architecture/boundaries": "error",
    "aobot-architecture/context-leaf": "error",
    "aobot-architecture/public-api": "error",
    "aobot-architecture/domain-purity": "error",
    "aobot-standards/no-effect-leaf-imports": "error",
    "aobot-standards/no-optional-values": "error",
    "aobot-standards/no-tagged-error-instanceof": "error",
    "aobot-standards/no-unjustified-non-null-assertion": "error",
    "aobot-standards/require-export-jsdoc": "error",
    "vite-plus/prefer-vite-plus-imports": "error",
  },
  overrides: [
    {
      files: ["apps/**/*.ts", "apps/**/*.tsx", "packages/**/*.ts"],
      rules: {
        "no-restricted-properties": [
          "error",
          {
            object: "process",
            property: "env",
            message:
              "Read settings through Effect Config in a config.ts layer, so they can be swapped and tested.",
          },
        ],
      },
    },
    {
      files: ["apps/server/src/**/*.ts"],
      rules: {
        "no-console": "error",
      },
    },
    {
      files: [
        "packages/domain/src/**/*.ts",
        "apps/server/src/features/policy/**/*.ts",
        "apps/*/src/**/redact.ts",
      ],
      rules: {
        "no-restricted-properties": [
          "error",
          {
            object: "process",
            property: "env",
            message:
              "Read settings through Effect Config in a config.ts layer, so they can be swapped and tested.",
          },
          {
            object: "Math",
            property: "random",
            message: "Decisions and redaction are pure: pass randomness in.",
          },
          {
            object: "Date",
            property: "now",
            message: "Decisions and redaction are pure: use Effect's Clock so tests control time.",
          },
          {
            object: "performance",
            property: "now",
            message: "Decisions and redaction are pure: use Effect's Clock so tests control time.",
          },
        ],
      },
    },
    {
      files: ["apps/*/src/**/config.ts"],
      rules: {
        "no-restricted-properties": "off",
      },
    },
    {
      files: ["**/*.test.ts", "**/*.test.tsx", "**/testing/**", "e2e/**", "verify/**"],
      rules: {
        "no-restricted-properties": "off",
        "no-console": "off",
        "aobot-standards/no-unjustified-non-null-assertion": "off",
      },
    },
  ],
} satisfies NonNullable<ViteUserConfig["lint"]>;
