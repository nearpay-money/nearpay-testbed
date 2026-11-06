/**
 * The few NearPay merchant routes the demo calls, driven by the spec route tables (fetch + spec types).
 * TODO(step 1.4): replace with `@nearpay/node` (`nearpay.checkout.sessions.create`) once it is
 * published to the local registry; the calls and the Idempotency-Key behaviour stay the same.
 */
import { randomUUID } from "node:crypto";
import {
  type AnyRoute,
  API_VERSION,
  type CheckoutSession,
  createCheckoutSession,
  ErrorEnvelope,
  getCheckoutSession,
  HEADERS,
  type RouteBody,
} from "@nearpay/spec";

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

export function nearpayClient(o: { apiBase: string; secretKey: string; fetch?: typeof fetch }): NearPayClient {
  const f = o.fetch ?? fetch;
  async function call(route: AnyRoute, path: string, body?: unknown, idempotencyKey?: string): Promise<unknown> {
    let res: Response;
    try {
      res = await f(`${o.apiBase}${path}`, {
        method: route.method,
        headers: {
          accept: "application/json",
          [HEADERS.authorization]: `Bearer ${o.secretKey}`,
          [HEADERS.apiVersion]: API_VERSION,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(route.method === "POST" ? { [HEADERS.idempotencyKey]: idempotencyKey ?? randomUUID() } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new NearPayApiError(`${route.id}: ${(e as Error).message}`, 0);
    }
    const json: unknown = await res.json().catch(() => null);
    if (res.status !== route.status) {
      const env = ErrorEnvelope.safeParse(json);
      throw new NearPayApiError(
        `${route.id} failed (${res.status}${env.success ? ` ${env.data.error.code}: ${env.data.error.message}` : ""})`,
        res.status,
        env.success ? env.data.error.code : undefined,
      );
    }
    return (route.response as NonNullable<AnyRoute["response"]>).parse(json);
  }
  return {
    createCheckoutSession: (body, key) =>
      call(createCheckoutSession, createCheckoutSession.path, body, key) as Promise<CheckoutSession>,
    getCheckoutSession: (id) =>
      call(
        getCheckoutSession,
        `${getCheckoutSession.path.replace("{id}", encodeURIComponent(id))}?expand[]=payment_intent`,
      ) as Promise<CheckoutSession>,
  };
}
