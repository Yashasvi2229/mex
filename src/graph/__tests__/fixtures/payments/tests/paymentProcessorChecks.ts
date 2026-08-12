// Fixture for the symbol-lookup search tests — the TEST-file half.
//
// Named `...Checks.ts` under `tests/` rather than `*.spec.ts` on purpose: it
// has to look like a test file to the graph (which classifies by path) without
// looking like one to the test runner (which would try to execute it).
//
// The destructured constant reproduces a real extraction shape: a require-time
// destructuring is captured verbatim as a declaration name, so an index holds a
// constant literally named `{ PaymentProcessor }` in a test file — which used
// to outrank the class of that name.

const { PaymentProcessor } = require("../PaymentProcessor");

export function checkCharge(): boolean {
  return new PaymentProcessor(null).charge(1);
}
