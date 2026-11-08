/**
 * Stage 2 E2E helpers (step 2.4): merchant API calls with the seeded secret key, Mailpit, console operators
 * (identity `operator-add` → enrolment mail → software passkey → ops session on `ops.<domain>`), the
 * merchant-demo webhook endpoint's Stage 2 events, and polling.
 */
import { randomUUID } from "node:crypto";
import { listWebhookEndpoints, updateWebhookEndpoint } from "@nearpay/spec";
import { call, type RouteCall } from "../../lib/http.js";
import { enrolmentToken, mailpit, OpsConsole } from "../../lib/ops-console.js";
import { ops, stack } from "./env.js";

type Route = Parameters<typeof call>[0];

/** A merchant route with the demo merchant's secret test key (Idempotency-Key on every POST). */
export function api<T = unknown>(route: Route, o: Omit<RouteCall, "base"> = {}): Promise<T> {
  const st = stack();
  const secretKey = st.secretKey();
  if (!secretKey) throw new Error("no merchant secret key (run nearpay-deploy/scripts/seed.sh data)");
  return call<T>(route, {
    base: st.apiUrl,
    secretKey,
    ...(route.method === "POST" ? { idempotencyKey: randomUUID() } : {}),
    ...o,
  });
}

export const mail = () => mailpit(stack().mailUrl);

/** A new console operator with `role`, enrolled and signed in (unique email per call). */
export async function operator(role: "ops" | "ops_admin", tag = "e2e"): Promise<OpsConsole & { email: string }> {
  const email = `${tag}-${role}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@nearpay.localhost`;
  const since = Date.now() - 2000;
  const r = ops("identity-api", ["operator-add", email, role, "--actor", "testbed:e2e"]);
  if (r.code !== 0) throw new Error(`operator-add failed: ${r.stderr || r.stdout}`);
  const text = await mail().latest(email, /console/i, 30_000, since);
  const op = await OpsConsole.enrol(stack().opsUrl, enrolmentToken(text));
  return Object.assign(op, { email });
}

/** The demo merchant's webhook endpoint at merchant-demo, with `events` enabled (adds what is missing). */
export async function ensureWebhookEvents(events: readonly string[]): Promise<void> {
  const list = await api<{ data: { id: string; url: string; enabled_events: string[] }[] }>(listWebhookEndpoints, {
    query: { limit: "100" },
  });
  const ep = list.data.find((e) => e.url === "http://merchant-demo:3000/webhooks");
  if (!ep) throw new Error("no merchant-demo webhook endpoint (run nearpay-deploy/scripts/seed.sh data)");
  if (ep.enabled_events.includes("*") || events.every((e) => ep.enabled_events.includes(e))) return;
  await api(updateWebhookEndpoint, {
    params: { id: ep.id },
    body: { enabled_events: [...new Set([...ep.enabled_events, ...events])] },
  });
}

/** Polls `get` until `done` holds (returns the last value) or throws after `timeoutMs`. */
export async function until<T>(get: () => Promise<T>, done: (v: T) => boolean, timeoutMs: number, what: string) {
  const end = Date.now() + timeoutMs;
  let last: T = await get();
  while (!done(last)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last).slice(0, 500)}`);
    await new Promise((r) => setTimeout(r, 2000));
    last = await get();
  }
  return last;
}
