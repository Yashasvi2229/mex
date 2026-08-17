/**
 * Grading — arm-neutral by construction.
 *
 * NL answers are graded on `(filePath, symbolName)`; multi-hop on bare neighbour names. Never
 * on a graph node id: only the graph arm is ever handed one, so grading on it would score the
 * arm for having been given the answer format.
 */
const norm = (s) => (s ?? "").trim().split("\\").join("/").replace(/^\.\//, "").toLowerCase();

export function gradeNl(answer, expected) {
  const fileOK = norm(answer?.filePath) === norm(expected.filePath);
  const symOK = (answer?.symbolName ?? "") === expected.symbolName;
  return { fileOK, symOK, correct: fileOK && symOK, notFound: (answer?.symbolName ?? "") === "NOT_FOUND" };
}

export function gradeMultihop(answer, expected) {
  const want = expected.neighbors.map(norm);
  const got = [...new Set((answer?.neighbors ?? []).map(norm))];
  const hit = got.filter((g) => want.includes(g));
  const recall = want.length ? hit.length / want.length : 0;
  const precision = got.length ? hit.length / got.length : 0;
  return { recall, precision, correct: recall === 1 && precision === 1 };
}

export function gradeTask(task, answer) {
  return task.kind === "nl" ? gradeNl(answer, task.expected) : gradeMultihop(answer, task.expected);
}
