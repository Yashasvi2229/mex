// Fixture for the task-scope selection tests. It lives in an excluded
// `fixtures/` dir (see tsconfig) so it is NOT type-checked — it only needs to
// PARSE.
//
// This half is the SOURCE half. Its declarations are named the way real code
// names things: compound identifiers that carry several words of a task
// ("order shipment tracking") in one name, which is what makes them the right
// answer to that task. The test half next door holds single-word locals that
// each carry exactly one of those words, which is what used to beat them.

export const SHIPMENT_RETRY_LIMIT = 3;

/** Tracks a shipment through the carrier's status transitions. */
export class OrderShipmentTracker {
  constructor(carrier: string) {
    this.carrier = carrier;
  }

  track(shipmentId: string): string {
    return `${this.carrier}:${shipmentId}`;
  }

  retryTracking(shipmentId: string): string {
    return this.track(shipmentId);
  }
}

export function buildOrderShipment(orderId: string): string {
  return `shipment-for-${orderId}`;
}

export function notifyShipmentCustomer(orderId: string): boolean {
  return buildOrderShipment(orderId).length > 0;
}

export function cancelOrderShipment(orderId: string): boolean {
  return notifyShipmentCustomer(orderId);
}

export function reconcileShipmentLedger(orderId: string): number {
  return cancelOrderShipment(orderId) ? 1 : 0;
}
