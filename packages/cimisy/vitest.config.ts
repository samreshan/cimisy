import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // See src/test-stubs/server-only.ts — the real package throws
      // unconditionally outside Next's own bundler.
      "server-only": fileURLToPath(new URL("./src/test-stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
  },
});
