// The referring file. It imports `auditTrail` (so the `instantiates` reference
// resolves) and imports NEITHER batch runner (so the `processBatch` call cannot
// be attributed to either of them).

import { ShipmentAudit } from "./auditTrail";

export function coordinateDispatch(batchId: string): string {
  const audit = new ShipmentAudit();
  const outcome = processBatch(batchId);
  // Calling the class as if it were a function: a `calls` reference naming a
  // declaration no call is allowed to bind to.
  ShipmentAudit();
  return audit.record(outcome);
}
