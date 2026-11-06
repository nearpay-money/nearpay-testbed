/** Client for merchant-demo's own routes (see merchant-demo/README.md). */
import { waitFor } from "./wait.js";

export interface DemoCheckout {
  id: string;
  url: string | null;
  payment_intent: string;
  amount: number;
  currency: string;
  livemode: boolean;
  expires_at: number;
}

export interface DemoEvent {
  id: string;
  type: string;
  livemode: boolean;
  created: number;
  object_id: string | null;
  received_at: number;
  event: { id: string; type: string; data: { object: Record<string, unknown> } };
}

export interface DemoOrder {
  id: string;
  status: string;
  livemode: boolean;
  amount: number | string;
  currency: string;
  payment_intent: {
    id: string;
    status?: string;
    amount_settled?: string;
    succeeded_at?: number | null;
    late?: boolean;
  };
  events: string[];
}

export function merchantDemo(base: string, f: typeof fetch = fetch) {
  const url = (p: string) => `${base.replace(/\/$/, "")}${p}`;
  async function json<T>(res: Response, what: string): Promise<T> {
    const body = await res.text();
    if (!res.ok) throw new Error(`merchant-demo ${what} → ${res.status} ${body.slice(0, 300)}`);
    return JSON.parse(body) as T;
  }
  const api = {
    premiumUrl: url("/premium"),
    /** `amount` (cents) and `expiresIn` (s) are test-mode overrides (sandbox scenarios). */
    async checkout(amount?: number, expiresIn?: number): Promise<DemoCheckout> {
      const res = await f(url("/checkout"), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          ...(amount === undefined ? {} : { amount }),
          ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
        }),
      });
      return json<DemoCheckout>(res, "POST /checkout");
    },
    async order(id: string): Promise<DemoOrder> {
      return json<DemoOrder>(await f(url(`/orders/${encodeURIComponent(id)}`)), "GET /orders");
    },
    async events(filter: { type?: string; object?: string } = {}): Promise<DemoEvent[]> {
      const q = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][]);
      return (await json<{ data: DemoEvent[] }>(await f(url(`/events?${q}`)), "GET /events")).data;
    },
    /** Waits until merchant-demo received (and verified) a matching webhook. */
    async waitForEvent(
      filter: { type: string; object?: string; match?: (e: DemoEvent) => boolean },
      timeoutMs: number,
      intervalMs = 1000,
    ): Promise<DemoEvent> {
      return waitFor(
        async () => {
          const list = await api.events({ type: filter.type, ...(filter.object ? { object: filter.object } : {}) });
          return list.find((e) => !filter.match || filter.match(e));
        },
        {
          timeoutMs,
          intervalMs,
          what: `webhook ${filter.type}${filter.object ? ` for ${filter.object}` : ""} at merchant-demo`,
        },
      );
    },
  };
  return api;
}
