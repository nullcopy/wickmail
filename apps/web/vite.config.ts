import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The web app is served from the management API origin in production, so it
// calls the same-origin `/v1` API. In development, Vite proxies `/v1` to the
// server so the app keeps using same-origin requests.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/v1": {
        target: process.env.WICKMAIL_API_URL ?? "http://127.0.0.1:8080",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    // wickmail-core exports TypeScript sources, so it must be transformed.
    server: { deps: { inline: ["wickmail-core"] } },
  },
});
