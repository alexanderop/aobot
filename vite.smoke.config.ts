import { defineConfig } from "vite-plus";

/**
`vp run test:smoke`: one real model turn, with the settings the server reads. Kept out of `vite.config.ts`
so `vp test run` never needs a key or the network.
*/
export default defineConfig({
  test: {
    name: "smoke",
    include: ["apps/*/src/**/*.smoke.ts"],
    environment: "node",
  },
});
