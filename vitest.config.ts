import { defineConfig } from "vitest/config";

/** `unit` is every workspace's tests; `architecture` tests the lint rules and the backlog. */
export default defineConfig({
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
