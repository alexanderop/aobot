import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

/** The server serves `dist` on port 3000; in dev the RPC socket, a person's files and the audit trail go to it through this proxy. */
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/rpc": { target: "http://localhost:3000", ws: true },
      "/files": { target: "http://localhost:3000" },
      "/audit/rows": { target: "http://localhost:3000" },
    },
  },
  build: { outDir: "dist" },
});
