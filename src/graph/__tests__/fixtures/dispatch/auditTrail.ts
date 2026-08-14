// Fixture for the unresolved-reference evidence tests. It lives in an excluded
// `fixtures/` dir (see tsconfig) so it is NOT type-checked — it only needs to
// PARSE.
//
// `ShipmentAudit` is the target of two DIFFERENT reference kinds from
// `coordinator.ts`, which is the whole point of it:
//
//   * `new ShipmentAudit()` is an `instantiates` reference, and it resolves —
//     exactly one class bears the name and the referring file imports it — so
//     the graph holds a real edge that `who-calls` does not read.
//   * `ShipmentAudit()` is a `calls` reference, and it CANNOT resolve: the
//     resolver binds a call only to a function or a method, so a call naming a
//     class has no eligible candidate at all.
//
// So one declaration produces one `related-edge` row and one `unresolved` row,
// and a test can tell them apart without contriving either.

export class ShipmentAudit {
  record(entry: string): string {
    return `audit:${entry}`;
  }
}
