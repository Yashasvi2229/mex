import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const fixtureModuleId = "virtual:mex-hub-fixture-api";

export default defineConfig(({ command }) => ({
  plugins: [react()],
  resolve: {
    alias: {
      [fixtureModuleId]: resolve(
        packageRoot,
        command === "build"
          ? "src/api/production-fixture-boundary.ts"
          : "src/dev/fixture-api.ts",
      ),
    },
  },
  build: {
    outDir: "../../dist/hub",
    emptyOutDir: true,
    manifest: true,
    sourcemap: false,
    target: "es2022",
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:4317",
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: true,
    restoreMocks: true,
    clearMocks: true,
  },
}));
