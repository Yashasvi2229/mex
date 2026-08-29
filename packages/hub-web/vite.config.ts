import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hubContractAliases } from "./scripts/contract-aliases.mjs";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const fixtureModuleId = "virtual:mex-hub-fixture-api";

export default defineConfig(({ command }) => ({
  esbuild: {
    legalComments: "eof",
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(packageRoot, "src"),
      ...hubContractAliases(packageRoot, command),
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
