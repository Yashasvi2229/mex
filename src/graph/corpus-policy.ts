import { createHash } from "node:crypto";
import { SUPPORTED_SOURCE_GLOB } from "./extraction/grammars.js";

/** One source of truth for repository files that participate in graph identity. */
export const GRAPH_CORPUS_IGNORE_GLOBS = Object.freeze([
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.mex/**",
  "**/coverage/**",
  "**/.next/**",
  "**/out/**",
] as const);

export const GRAPH_CONFIG_GLOBS = Object.freeze([
  "package.json",
  "**/package.json",
  "tsconfig*.json",
  "**/tsconfig*.json",
  "jsconfig*.json",
  "**/jsconfig*.json",
] as const);

export const GRAPH_SUPPORTED_SOURCE_GLOB = SUPPORTED_SOURCE_GLOB;
export const GRAPH_CORPUS_GLOB_OPTIONS = Object.freeze({
  absolute: false,
  dot: false,
  follow: false,
  nodir: true,
} as const);

/**
 * Stable identity for discovery semantics, independent of machine locale.
 * Changing this policy invalidates the existing graph through manifestHash.
 */
export const GRAPH_CORPUS_POLICY_HASH = createHash("sha256").update(JSON.stringify({
  version: 1,
  sourceGlob: GRAPH_SUPPORTED_SOURCE_GLOB,
  ignoreGlobs: GRAPH_CORPUS_IGNORE_GLOBS,
  configGlobs: GRAPH_CONFIG_GLOBS,
  globOptions: GRAPH_CORPUS_GLOB_OPTIONS,
})).digest("hex");
