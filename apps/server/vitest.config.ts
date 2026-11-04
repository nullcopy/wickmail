import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // wickmail-core is a workspace package that exports TypeScript sources, so
    // it must be transformed rather than externalized.
    server: { deps: { inline: ["wickmail-core"] } },
  },
});
