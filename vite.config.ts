import { defineConfig } from "vite-plus";
import { lintConfig } from "./tools/oxlint/config.ts";

/** One config for the whole toolchain: `vp check` (format, lint, type-check) and `vp test`. */
export default defineConfig({
  lint: {
    ...lintConfig,
    options: { typeAware: true, typeCheck: true },
  },
  fmt: {
    ignorePatterns: ["tools/oxlint/anti-slop/**", "pnpm-lock.yaml"],
  },
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["apps/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "architecture",
          include: ["tools/oxlint/aobot-*/**/*.test.ts", "tools/docs/**/*.test.ts"],
          environment: "node",
        },
      },
    ],
  },
});
