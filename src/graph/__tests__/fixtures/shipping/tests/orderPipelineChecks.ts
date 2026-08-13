// Fixture for the task-scope selection tests — the TEST-file half.
//
// Named `...Checks.ts` under `tests/` rather than `*.spec.ts` on purpose: it has
// to look like a test file to the graph (which classifies by path) without
// looking like one to the test runner (which would try to execute it).
//
// Every local here is a declaration named with ONE ordinary word that also
// appears in a realistic task about this corpus. That is the shape measured on a
// large index: a scope query for "order shipment tracking" was answered by a
// two-line `const shipment` inside a spec file, because matching one word of the
// task exactly outscored matching the whole of it well.

const { OrderShipmentTracker, buildOrderShipment } = require("../orderPipeline");

const order = "order-1";
const shipment = buildOrderShipment(order);
const tracking = new OrderShipmentTracker("carrier-a");
const carrier = "carrier-a";
const ledger = 0;

export function checkTracking(): string {
  return tracking.track(shipment);
}

export function checkCarrierLedger(): number {
  return carrier.length + ledger;
}
