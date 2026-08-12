// Fixture for the symbol-lookup search tests. It lives in an excluded
// `fixtures/` dir (see tsconfig) so it is NOT type-checked — it only needs to
// PARSE, which lets it reference symbols from "other files" the way real code
// does.
//
// The shapes here are the ones that were measured to break exact-name lookup:
//   * the file is named after the class it declares, so the `file:` node
//     competes with the class on a symbol query;
//   * the class has members whose qualified names all carry the class name;
//   * a second declaration shares the class name as a prefix;
//   * `getUserById` exists to be found by a substring (`serby`) that no prefix
//     search can reach.

export const THE_DEFAULT_TIMEOUT = 30;

/** Charges and refunds a customer's card. */
export class PaymentProcessor {
  constructor(gateway: Gateway) {
    this.gateway = gateway;
  }

  charge(amount: number): boolean {
    return this.gateway.send(amount);
  }

  refund(amount: number): boolean {
    return this.gateway.send(-amount);
  }
}

export class PaymentProcessorFactory {
  create(): PaymentProcessor {
    return new PaymentProcessor(new Gateway());
  }
}

export function getUserById(id: string): string {
  return id;
}
