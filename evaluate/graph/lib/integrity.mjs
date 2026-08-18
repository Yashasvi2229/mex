import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { stableJson } from "../../core/hash.mjs";
import { round } from "../../core/stats.mjs";

const require = createRequire(import.meta.url);
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning, ...rest) => {
  const message = typeof warning === "string" ? warning : warning?.message;
  if (typeof message === "string" && /SQLite is an experimental feature/i.test(message)) return;
  return originalEmitWarning(warning, ...rest);
});
const { DatabaseSync } = require("node:sqlite");

function scalar(db, sql, params = []) {
  const row = db.prepare(sql).get(...params);
  return Number(row?.value ?? 0);
}

function rows(db, sql) {
  return db.prepare(sql).all().map((row) => ({ ...row }));
}

function duplicateExcess(db, columns) {
  return scalar(db, `SELECT COALESCE(SUM(count - 1), 0) AS value FROM (SELECT COUNT(*) AS count FROM nodes GROUP BY ${columns} HAVING COUNT(*) > 1)`);
}

function normalizedGraphHash(db) {
  const hash = createHash("sha256");
  const tables = [
    ["nodes", `SELECT id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column,
      docstring, signature, visibility, is_exported, is_async, is_static, is_abstract, decorators, type_parameters,
      return_type, body_hash FROM nodes ORDER BY id`],
    ["edges", "SELECT source, target, kind, metadata, line, col, provenance FROM edges ORDER BY source, target, kind, line, col"],
    ["files", "SELECT path, content_hash, language, size, node_count, errors FROM files ORDER BY path"],
    ["unresolved_refs", `SELECT from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language
      FROM unresolved_refs ORDER BY from_node_id, reference_name, reference_kind, line, col`],
  ];
  for (const [name, sql] of tables) {
    hash.update(`${name}\0`);
    for (const row of rows(db, sql)) hash.update(`${stableJson(row)}\n`);
  }
  return hash.digest("hex");
}

export function inspectGraphDatabase(path, buildSummary = null) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const nodes = scalar(db, "SELECT COUNT(*) AS value FROM nodes");
    const files = scalar(db, "SELECT COUNT(*) AS value FROM files");
    const extractedFileNodes = scalar(db, "SELECT COALESCE(SUM(node_count), 0) AS value FROM files");
    const storedFileNodes = scalar(db, "SELECT COUNT(*) AS value FROM nodes INNER JOIN files ON files.path = nodes.file_path");
    const edges = scalar(db, "SELECT COUNT(*) AS value FROM edges");
    const callEdges = scalar(db, "SELECT COUNT(*) AS value FROM edges WHERE kind = 'calls'");
    const unresolvedReferences = scalar(db, "SELECT COUNT(*) AS value FROM unresolved_refs");
    const unresolvedCalls = scalar(db, "SELECT COUNT(*) AS value FROM unresolved_refs WHERE reference_kind IN ('calls', 'function_ref', 'instantiates')");
    const callableNodes = scalar(db, "SELECT COUNT(*) AS value FROM nodes WHERE kind IN ('function', 'method', 'route', 'component')");
    const noIncomingCalls = scalar(db, `SELECT COUNT(*) AS value FROM nodes n WHERE n.kind IN ('function', 'method', 'route', 'component')
      AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.kind = 'calls' AND e.target = n.id)`);
    const noOutgoingCalls = scalar(db, `SELECT COUNT(*) AS value FROM nodes n WHERE n.kind IN ('function', 'method', 'route', 'component')
      AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.kind = 'calls' AND e.source = n.id)`);
    const integrity = {
      files,
      nodes,
      extractedFileNodes,
      storedFileNodes,
      extractedToStoredLoss: Math.max(0, extractedFileNodes - storedFileNodes),
      nonFileOrFrameworkNodes: Math.max(0, nodes - storedFileNodes),
      buildNodesCreated: Number(buildSummary?.nodesCreated ?? NaN),
      buildToStoredDelta: Number.isFinite(Number(buildSummary?.nodesCreated)) ? nodes - Number(buildSummary.nodesCreated) : null,
      edges,
      callEdges,
      unresolvedReferences,
      unresolvedCalls,
      unresolvedCallRate: callEdges + unresolvedCalls ? round(unresolvedCalls / (callEdges + unresolvedCalls)) : 0,
      danglingEdges: scalar(db, `SELECT COUNT(*) AS value FROM edges e LEFT JOIN nodes s ON s.id = e.source
        LEFT JOIN nodes t ON t.id = e.target WHERE s.id IS NULL OR t.id IS NULL`),
      danglingUnresolvedSources: scalar(db, "SELECT COUNT(*) AS value FROM unresolved_refs r LEFT JOIN nodes n ON n.id = r.from_node_id WHERE n.id IS NULL"),
      duplicateFileKindName: duplicateExcess(db, "file_path, kind, name"),
      duplicateQualifiedIdentity: duplicateExcess(db, "file_path, kind, qualified_name"),
      ftsRowDelta: scalar(db, "SELECT COUNT(*) AS value FROM nodes_fts") - nodes,
      filesWithExtractionErrors: scalar(db, "SELECT COUNT(*) AS value FROM files WHERE errors IS NOT NULL AND errors NOT IN ('', '[]')"),
      callableNodes,
      noIncomingCalls,
      noIncomingCallRate: callableNodes ? round(noIncomingCalls / callableNodes) : 0,
      noOutgoingCalls,
      noOutgoingCallRate: callableNodes ? round(noOutgoingCalls / callableNodes) : 0,
      edgeKinds: Object.fromEntries(rows(db, "SELECT kind, COUNT(*) AS count FROM edges GROUP BY kind ORDER BY kind").map((row) => [row.kind, Number(row.count)])),
      unresolvedKinds: Object.fromEntries(rows(db, "SELECT reference_kind AS kind, COUNT(*) AS count FROM unresolved_refs GROUP BY reference_kind ORDER BY reference_kind").map((row) => [row.kind, Number(row.count)])),
      normalizedGraphSha256: normalizedGraphHash(db),
    };
    return integrity;
  } finally {
    db.close();
  }
}
