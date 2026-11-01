import { defineConfig } from "vite-plus";

/**
`vp run test:contract:agents`: the agent runtime contract suite (tier 3), against the mock model server
and the real CLI adapters. Kept out of `vite.config.ts` because it starts real CLIs.
*/
export default defineConfig({
  test: {
    name: "contract",
    include: ["apps/server/src/**/*.contract.ts"],
    environment: "node",
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
