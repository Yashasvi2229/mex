import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", relay: "src/relay.ts" },
  format: ["esm"],
  target: "es2022",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: true,
});
