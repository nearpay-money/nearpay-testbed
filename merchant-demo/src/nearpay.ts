/** The NearPay merchant calls the demo makes, through `@nearpay-money/node` (lld/sdks-and-tools.md §1). */
import { NearPay, NearPayError } from "@nearpay-money/node";
import type { CheckoutSession, createCheckoutSession, RouteBody } from "@nearpay-money/spec";

export class NearPayApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "NearPayApiError";
  }
}

export interface NearPayClient {
  createCheckoutSession(
    body: RouteBody<typeof createCheckoutSession>,
    idempotencyKey?: string,
  ): Promise<CheckoutSession>;
  getCheckoutSession(id: string): Promise<CheckoutSession>;
}

async function mapped<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof NearPayError) throw new NearPayApiError(e.message, e.statusCode ?? 0, e.code);
    throw e;
  }
}

export function nearpayClient(o: { apiBase: string; secretKey: string; fetch?: typeof fetch }): NearPayClient {
  const nearpay = new NearPay(o.secretKey, {
    baseUrl: o.apiBase,
    appInfo: "merchant-demo/0.1.0",
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  return {
    // The SDK adds an Idempotency-Key (UUIDv4) and reuses it across its retries.
    createCheckoutSession: (body, idempotencyKey) =>
      mapped(
        nearpay.checkout.sessions.create(body, idempotencyKey ? { idempotencyKey } : undefined),
      ) as Promise<CheckoutSession>,
    getCheckoutSession: (id) =>
      mapped(nearpay.checkout.sessions.retrieve(id, { expand: ["payment_intent"] })) as Promise<CheckoutSession>,
  };
}
