// Half of a deliberate name collision. `beta/batchRunner.ts` exports a function
// with the SAME name, and `coordinator.ts` calls it while importing neither —
// so the resolver finds two eligible, exported candidates, has no same-file or
// import preference to break the tie, and declines to bind. That is the
// `ambiguous` half of the evidence split, and it is the shape the resolver
// actually produces rather than one forced with a mock.

export function processBatch(batchId: string): string {
  return `alpha:${batchId}`;
}
