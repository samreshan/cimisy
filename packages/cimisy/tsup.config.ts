import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/**/*.ts", "src/**/*.tsx", "!src/**/__tests__/**", "!src/test-stubs/**"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  // No bundling: transpile each source file 1:1 into dist/, preserving the
  // module graph as real ESM imports (mirrors `tsc`'s output layout). This
  // is what keeps a "use client" directive attached to its own file rather
  // than getting merged into a shared chunk with server-only code, which
  // is exactly the failure mode that broke the admin UI's RSC boundary.
  bundle: false,
  external: ["react", "react-dom", "next"],
});
