// Fixture for the segmented-index search tests. It lives in an excluded
// `fixtures/` dir (see tsconfig) so it is NOT type-checked — it only needs to
// PARSE.
//
// Two shapes, both measured on a real corpus before they were written down. In
// each, one declaration hides a word inside a camelCase name and a SECOND
// declaration carries that same word as a prefix:
//
//   * `formatMoney` against `moneyFormatDefaults`;
//   * `runMigrations` against `migrationTemplate`.
//
// The second declaration is what makes the case bite. FTS5 indexes a name as
// one token, so `money*` cannot reach `formatmoney`; the substring tier would,
// but it only fires for a term that matches NOTHING in the pool, and the
// prefix-carrying neighbour satisfies the term. So the mid-name match is
// unreachable at any fetch depth.
//
// Nothing here may repeat those words in a docstring or a signature: those are
// indexed columns, and a mention there would let the old index answer the
// question for the wrong reason and quietly make the test pass.

export const migrationTemplate = "-- template";

export const moneyFormatDefaults = { currency: "EUR" };

/** Applies every pending ledger change, in order. */
export function runMigrations(pending: string[]): number {
  return pending.length;
}

/** Renders a minor-unit amount as a display string. */
export function formatMoney(amountInCents: number): string {
  return `${(amountInCents / 100).toFixed(2)}`;
}

export function reconcileLedgerAccounts(ledgerId: string): boolean {
  return runMigrations([ledgerId]).valueOf() > 0;
}
