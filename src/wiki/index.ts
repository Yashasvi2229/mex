/**
 * MEX Wiki Engine.
 *
 * A Markdown-canonical knowledge graph over the `.mex` scaffold: Markdown is
 * the source of truth and is Git-tracked, while `.mex/wiki.db` is a disposable
 * projection that can be deleted and rebuilt without losing knowledge.
 *
 * Only the canonical model is implemented so far. The Markdown codec, index,
 * grounding adapter, operations pipeline, migration, synthesis and CLI land in
 * later phases and will export from here.
 */

export * from "./model/index.js";
