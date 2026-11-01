import { defineConfig } from "vite-plus";

/**
`vp run test:contract`: the computer provider contract suite (tier 3), against the real `docker` image.
Kept out of `vite.config.ts` and the agents suite because it builds and runs containers.
*/
export default defineConfig({
  test: {
    name: "contract-computers",
    include: ["apps/computer/src/**/*.contract.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 900_000,
  },
});
