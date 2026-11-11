/**
 * Operator sessions on the console host for E2E suites (lld/dashboard-and-console.md §2, identity §8.1):
 * `ops.<domain>/api/ops/*` exactly as the console calls it — same origin, ops cookie, CSRF header on
 * writes, `401 step_up_required` answered by a passkey step-up and replayed with the same
 * Idempotency-Key. Operators are created with identity's in-container ops CLI (`operator-add`, local
 * stacks), the enrolment link comes from Mailpit and the passkey is the software authenticator in
 * `webauthn.ts` (all-zero AAGUID: accepted only with NP_ENV local/test).
 */
import { randomUUID } from "node:crypto";
import {
  OPS_ROUTES,
  opsEnrolmentVerify,
  opsPasskeyAuthenticationOptions,
  opsPasskeyAuthenticationVerify,
  opsPasskeyRegistrationOptions,
  opsPasskeyRegistrationVerify,
  opsStepUpOptions,
  opsStepUpVerify,
} from "@nearpay-internal/spec";
import {
  API_VERSION,
  ErrorEnvelope,
  HEADERS,
  passkeyRegistrationOptions,
  passkeyRegistrationVerify,
  signup,
  stepUpOptions,
  stepUpVerify,
  verifyMagicLink,
} from "@nearpay-money/spec";
import { ApiError, routeUrl } from "./http.js";
import { createCredential, getAssertion, type SoftCredential } from "./webauthn.js";

type OpsRoute = (typeof OPS_ROUTES)[number];
/** Any spec route (public or ops) — the client only needs method, path, status, schemas. */
export interface SessionRoute {
  id: string;
  method: string;
  path: string;
  status: number;
  idempotent?: boolean;
  response?: { parse(v: unknown): unknown } | null | undefined;
}

export interface Mailpit {
  /** Newest message to `to` whose subject matches, as plain text (waits up to `timeoutMs`). */
  latest(to: string, subject: RegExp, timeoutMs?: number, after?: number): Promise<string>;
}

export function mailpit(base: string, f: typeof fetch = fetch): Mailpit {
  return {
    async latest(to, subject, timeoutMs = 30_000, after = 0) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const list = (await (
          await f(`${base}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}&limit=20`)
        ).json()) as {
          messages: { ID: string; Subject: string; Created: string }[];
        };
        const m = list.messages.find((x) => subject.test(x.Subject) && Date.parse(x.Created) >= after);
        if (m) return ((await (await f(`${base}/api/v1/message/${m.ID}`)).json()) as { Text: string }).Text;
        if (Date.now() > until) throw new Error(`no mail "${subject}" to ${to} within ${timeoutMs} ms`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    },
  };
}

export interface OpsCallOptions {
  params?: Record<string, string>;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  idempotencyKey?: string;
}

/**
 * A browser-like session client on a NearPay host (console or dashboard): same-origin `/api`, cookie
 * jar, CSRF header on writes, `401 step_up_required` → passkey step-up → replay with the same key.
 */
export class SessionClient {
  protected cookie = "";
  protected csrf = "";
  /** `NearPay-Mode` sent with every call (dashboard sessions: `live` or `test`). */
  mode: "live" | "test" | undefined;
  constructor(
    readonly origin: string,
    public credential: SoftCredential,
    protected readonly stepUpRoutes: { options: SessionRoute; verify: SessionRoute },
    protected readonly f: typeof fetch = fetch,
  ) {}

  get api() {
    return `${this.origin}/api`;
  }

  protected async raw(route: SessionRoute, o: OpsCallOptions, idem?: string) {
    const write = route.method !== "GET";
    const res = await this.f(routeUrl(route as never, { base: this.api, params: o.params, query: o.query }), {
      method: route.method,
      headers: {
        accept: "application/json",
        origin: this.origin,
        [HEADERS.apiVersion]: API_VERSION,
        ...(this.mode ? { [HEADERS.mode]: this.mode } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(write && this.csrf ? { [HEADERS.csrf]: this.csrf } : {}),
        ...(o.body !== undefined || write ? { "content-type": "application/json" } : {}),
        ...(idem ? { [HEADERS.idempotencyKey]: idem } : {}),
      },
      ...(o.body !== undefined || write ? { body: JSON.stringify(o.body ?? {}) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    this.takeCookies(res);
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // not JSON
    }
    return { res, json, text };
  }

  private takeCookies(res: Response) {
    const set = res.headers.getSetCookie?.() ?? [];
    if (!set.length) return;
    const jar = new Map(
      this.cookie
        .split("; ")
        .filter(Boolean)
        .map((c) => [c.slice(0, c.indexOf("=")), c.slice(c.indexOf("=") + 1)] as const),
    );
    for (const c of set) {
      const [pair] = c.split(";");
      const at = (pair as string).indexOf("=");
      const name = (pair as string).slice(0, at);
      const value = (pair as string).slice(at + 1);
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(c) || value === "") jar.delete(name);
      else jar.set(name, value);
    }
    this.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  /** Calls an ops route; answers `401 step_up_required` with a step-up and replays (same key). */
  async call<T = unknown>(route: SessionRoute, o: OpsCallOptions = {}): Promise<T> {
    const idem = route.idempotent ? (o.idempotencyKey ?? randomUUID()) : undefined;
    let r = await this.raw(route, o, idem);
    const code = () => ErrorEnvelope.safeParse(r.json).data?.error.code;
    if (r.res.status === 401 && code() === "step_up_required") {
      await this.stepUp();
      r = await this.raw(route, o, idem);
    }
    if (r.res.status !== route.status) {
      const env = ErrorEnvelope.safeParse(r.json);
      throw new ApiError(
        `${route.id} → ${r.res.status}${env.success ? ` ${env.data.error.code}: ${env.data.error.message}` : ` ${r.text.slice(0, 200)}`}`,
        r.res.status,
        env.success ? env.data.error.code : undefined,
        env.success ? env.data.error.request_id : undefined,
      );
    }
    if (route.response) this.remember(route.response.parse(r.json));
    return (route.response ? route.response.parse(r.json) : undefined) as T;
  }

  private remember(body: unknown) {
    const t = (body as { csrf_token?: unknown } | null)?.csrf_token;
    if (typeof t === "string") this.csrf = t;
  }

  async stepUp(): Promise<void> {
    const options = await this.call<{ challenge: string; rpId?: string }>(this.stepUpRoutes.options, { body: {} });
    await this.call(this.stepUpRoutes.verify, {
      body: { credential: getAssertion(options, this.origin, this.credential) },
    });
  }
}

/** A signed-in operator on the console host. */
export class OpsConsole extends SessionClient {
  constructor(origin: string, credential: SoftCredential, f: typeof fetch = fetch) {
    super(origin, credential, { options: opsStepUpOptions, verify: opsStepUpVerify }, f);
  }

  /** Passkey sign-in (anonymous ceremony) → ops session cookie + CSRF token. */
  async signIn(): Promise<unknown> {
    const options = await this.call<{ challenge: string; rpId?: string }>(opsPasskeyAuthenticationOptions, {
      body: {},
    });
    return this.call(opsPasskeyAuthenticationVerify, {
      body: { credential: getAssertion(options, this.origin, this.credential) },
    });
  }

  /**
   * Enrols an operator from the token of their enrolment link and signs in: registration with the
   * software authenticator, then a passkey sign-in (the verify response may already carry a session).
   */
  static async enrol(origin: string, token: string, f: typeof fetch = fetch): Promise<OpsConsole> {
    const anon = new OpsConsole(origin, null as unknown as SoftCredential, f);
    const reg = await anon.call<{ registration_token: string }>(opsEnrolmentVerify, { body: { token } });
    const options = await anon.call<Parameters<typeof createCredential>[0]>(opsPasskeyRegistrationOptions, {
      body: { registration_token: reg.registration_token },
    });
    const { credential, response } = createCredential(options, origin);
    await anon.call(opsPasskeyRegistrationVerify, {
      body: { registration_token: reg.registration_token, credential: response, passkey_name: "testbed soft key" },
    });
    const op = new OpsConsole(origin, credential, f);
    await op.signIn();
    return op;
  }
}

/** The enrolment token from an enrolment mail (link `…/auth/enrol#token=<token>`). */
export function enrolmentToken(mailText: string): string {
  const m = /[#?&]token=([A-Za-z0-9_-]{16,256})/.exec(mailText);
  if (!m) throw new Error("no enrolment token in the mail");
  return m[1] as string;
}

export function opsRoute(id: string): OpsRoute {
  const r = OPS_ROUTES.find((x) => x.id === id);
  if (!r) throw new RangeError(`no ops route ${id}`);
  return r;
}

/**
 * A merchant dashboard session (dashboard host, `/api` same-origin): sign-up with the always-pass
 * Turnstile test token → magic link (Mailpit) → passkey registration (software authenticator) creates
 * the user, the account (owner) and the session.
 */
export class DashboardSession extends SessionClient {
  constructor(origin: string, credential: SoftCredential, f: typeof fetch = fetch) {
    super(origin, credential, { options: stepUpOptions, verify: stepUpVerify }, f);
  }

  static async signUp(
    origin: string,
    o: { email: string; displayName: string; mail: Mailpit; turnstileToken: string },
    f: typeof fetch = fetch,
  ): Promise<DashboardSession> {
    const s = new DashboardSession(origin, null as unknown as SoftCredential, f);
    const t0 = Date.now() - 2000;
    await s.call(signup, { body: { email: o.email, turnstile_token: o.turnstileToken } });
    const text = await o.mail.latest(o.email, /./, 60_000, t0);
    const token = /[#?&]token=([A-Za-z0-9_-]{16,256})/.exec(text)?.[1];
    if (!token) throw new Error("no magic link token in the sign-up mail");
    const verified = await s.call<{ registration_token?: string }>(verifyMagicLink, { body: { token } });
    if (!verified.registration_token) throw new Error("magic link verify returned no registration token");
    const options = await s.call<Parameters<typeof createCredential>[0]>(passkeyRegistrationOptions, {
      body: { registration_token: verified.registration_token },
    });
    const { credential, response } = createCredential(options, origin);
    s.credential = credential;
    await s.call(passkeyRegistrationVerify, {
      body: {
        registration_token: verified.registration_token,
        credential: response,
        passkey_name: "testbed soft key",
        display_name: o.displayName,
      },
    });
    return s;
  }
}
