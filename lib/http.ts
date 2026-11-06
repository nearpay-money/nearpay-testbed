/** Calls public NearPay routes from the spec route tables (secret key or client secret auth). */
import { type AnyRoute, API_VERSION, ErrorEnvelope, HEADERS } from "@nearpay/spec";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
    readonly requestId: string | undefined,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface RouteCall {
  base: string;
  params?: Record<string, string>;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  /** `Authorization: Bearer <key>` (merchant routes). */
  secretKey?: string;
  /** `X-NearPay-Client-Secret` (payer routes). */
  clientSecret?: string;
  idempotencyKey?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function routeUrl(route: AnyRoute, o: Pick<RouteCall, "base" | "params" | "query">): string {
  const path = route.path.replace(/\{([a-z_]+)\}/g, (_m, k: string) => {
    const v = o.params?.[k];
    if (v === undefined) throw new RangeError(`${route.id}: missing path parameter ${k}`);
    return encodeURIComponent(v);
  });
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(o.query ?? {})) {
    if (v === undefined) continue;
    for (const x of Array.isArray(v) ? v : [v]) q.append(k, x);
  }
  const qs = q.toString();
  return `${o.base.replace(/\/$/, "")}${path}${qs ? `?${qs}` : ""}`;
}

/** Calls a route and returns its response parsed with the route's response schema. */
export async function call<T = unknown>(route: AnyRoute, o: RouteCall): Promise<T> {
  const res = await (o.fetch ?? fetch)(routeUrl(route, o), {
    method: route.method,
    headers: {
      accept: "application/json",
      [HEADERS.apiVersion]: API_VERSION,
      ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(o.secretKey ? { [HEADERS.authorization]: `Bearer ${o.secretKey}` } : {}),
      ...(o.clientSecret ? { [HEADERS.clientSecret]: o.clientSecret } : {}),
      ...(o.idempotencyKey ? { [HEADERS.idempotencyKey]: o.idempotencyKey } : {}),
      ...o.headers,
    },
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
    signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }
  if (res.status !== route.status) {
    const env = ErrorEnvelope.safeParse(json);
    throw new ApiError(
      `${route.id} → ${res.status}${env.success ? ` ${env.data.error.code}: ${env.data.error.message}` : ` ${text.slice(0, 200)}`}`,
      res.status,
      env.success ? env.data.error.code : undefined,
      env.success ? env.data.error.request_id : (res.headers.get(HEADERS.requestId) ?? undefined),
    );
  }
  if (!route.response) return undefined as T;
  return route.response.parse(json) as T;
}
