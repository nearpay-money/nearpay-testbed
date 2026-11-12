/**
 * Live merchant onboarding (step 1.5, README "Mainnet demo" step 1): `pnpm onboard:live [--headed]`.
 *
 * Onboards the demo merchant on the local stack with no human step, in Chrome driven by Playwright's
 * library API, and continues from wherever an earlier run stopped:
 *
 *   1. account   — first run: sign-up (Turnstile stub) → magic link from Mailpit → passkey created
 *                  in a CDP virtual authenticator; the credential (with its private key) is saved to
 *                  `--passkey` (0600). Later runs load it (`WebAuthn.addCredential`) and sign in.
 *   2. name      — the account's display name follows `--business`.
 *   3. destination — live USDC NEAR Intents destination for the merchant key's implicit account;
 *                  the NEP-413 attestation is signed in Node with that key (`--merchant-key`).
 *   4. activation — active as soon as attested (ADR-0027, `NP_COOLOFF_SECONDS=0`); only on a stack that
 *                  sets a cool-off is it ended with the ops CLI skip (local stacks).
 *   5. KYB       — self-declared business details submitted through the API; compliance decides at
 *                  once (NP_KYB_MODE=auto, ADR-0024) → `live_enabled`. Only `--kyb-mode manual`
 *                  decides the case with the ops CLI.
 *   6. live key  — `sk_live_…` written to `<secrets-dir>/secret_key` (0600).
 *   7. webhook   — live endpoint (`*`), its signing secret appended to `<secrets-dir>/webhook_secret`.
 *
 * API calls run inside the dashboard page (same-origin `/api`, session cookie, CSRF header); a
 * `step_up_required` answer is met with a fresh passkey assertion and the call is replayed with the
 * same Idempotency-Key, like the dashboard's own client. Secrets and private keys are never printed.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { type BrowserContext, type CDPSession, chromium, type Page } from "@playwright/test";
import { chromeExecutable, localCertArgs } from "../lib/chrome.js";
import { serviceOps } from "../lib/compose.js";
import {
  appendSecret,
  credentialForReuse,
  type DestinationLike,
  demoKybProfile,
  findDestination,
  hasSecretHash,
  KEY_NAME,
  keyInFile,
  keyPrefix,
  kybStep,
  loadPasskey,
  loadState,
  type MerchantKey,
  ONBOARD_USAGE,
  type OnboardOptions,
  type OnboardState,
  type PasskeyRecord,
  parseMerchantKey,
  parseOnboardArgs,
  passkeyRecord,
  pickCredential,
  readSecret,
  savePasskey,
  saveState,
  sha256Hex,
  signNep413,
  USDC_NEAR,
  type VirtualCredential,
  writePrivateFile,
} from "../lib/onboard.js";
import { stackFromEnv } from "../lib/stack.js";
import { runCli } from "../ops/cli.js";

const API_VERSION = "2026-11-01";
const TURNSTILE_STUB = `window.turnstile = {
  render(el, o) { setTimeout(() => o.callback("XXXX.DUMMY.TOKEN.XXXX"), 20); return "w" + Math.random(); },
  reset() {}, remove() {}
};`;

const log = (s: string) => process.stdout.write(`${s}\n`);
const step = (n: number, s: string) => log(`[${n}/7] ${s}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface ApiErrorBody {
  error?: { code?: string; message?: string; type?: string };
}

class ApiFailure extends Error {
  constructor(
    readonly what: string,
    readonly status: number,
    readonly code: string | undefined,
    message: string | undefined,
  ) {
    super(`${what}: ${status} ${code ?? "error"}${message ? ` — ${message}` : ""}`);
    this.name = "ApiFailure";
  }
}

// ---------------------------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------------------------

interface Browser {
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  authenticatorId: string;
  close(): Promise<void>;
}

export async function openBrowser(o: OnboardOptions): Promise<Browser> {
  const browser = await chromium.launch({
    channel: "chrome",
    executablePath: chromeExecutable(),
    headless: !o.headed,
    args: localCertArgs(o.deployDir),
  });
  const context = await browser.newContext();
  // No third-party scripts: the local stack keeps the always-pass Turnstile test keys (NP_ENV=local),
  // and the destination is attested in Node, so the NEAR Connect wallet list is not needed.
  await context.route("https://challenges.cloudflare.com/**", (r) =>
    r.fulfill({ status: 200, contentType: "text/javascript", body: TURNSTILE_STUB }),
  );
  await context.route(/raw\.githubusercontent\.com|cdn\.jsdelivr\.net/, (r) =>
    r.fulfill({ contentType: "application/json", body: JSON.stringify({ wallets: [], version: "1.0.0" }) }),
  );
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { context, page, cdp, authenticatorId, close: () => browser.close() };
}

export async function credentials(b: Browser): Promise<VirtualCredential[]> {
  const r = await b.cdp.send("WebAuthn.getCredentials", { authenticatorId: b.authenticatorId });
  return r.credentials as unknown as VirtualCredential[];
}

// ---------------------------------------------------------------------------------------------
// Dashboard API (same-origin, inside the page)
// ---------------------------------------------------------------------------------------------

type Mode = "live" | "test";

interface CallOptions {
  mode?: Mode;
  body?: unknown;
  /** Send an Idempotency-Key (the spec's idempotent writes). */
  idempotent?: boolean;
}

export class DashboardApi {
  csrf: string | undefined;
  /** Runs after every accepted passkey assertion (the script saves the new sign counter). */
  afterAssertion: (() => Promise<void>) | undefined;
  constructor(readonly page: Page) {}

  async raw(
    method: string,
    path: string,
    o: CallOptions & { idem?: string } = {},
  ): Promise<{ status: number; body: unknown }> {
    return this.page.evaluate(
      async ({ method, path, mode, body, csrf, idem, version }) => {
        const headers: Record<string, string> = {
          Accept: "application/json",
          "NearPay-Mode": mode,
          "NearPay-Version": version,
        };
        let payload: string | undefined;
        if (method !== "GET") {
          if (csrf) headers["X-CSRF-Token"] = csrf;
          if (idem) headers["Idempotency-Key"] = idem;
          if (method !== "DELETE") {
            headers["Content-Type"] = "application/json";
            payload = JSON.stringify(body ?? {});
          }
        }
        const r = await fetch(`/api${path}`, {
          method,
          headers,
          body: payload,
          credentials: "same-origin",
          cache: "no-store",
        });
        const text = await r.text();
        let json: unknown = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        return { status: r.status, body: json };
      },
      {
        method,
        path,
        mode: o.mode ?? "live",
        body: o.body ?? null,
        csrf: this.csrf ?? null,
        idem: o.idem ?? null,
        version: API_VERSION,
      },
    );
  }

  async call<T>(method: string, path: string, o: CallOptions = {}): Promise<T> {
    const idem = o.idempotent ? randomUUID() : undefined;
    for (let attempt = 0; ; attempt++) {
      const r = await this.raw(method, path, { ...o, idem });
      if (r.status >= 200 && r.status < 300) return r.body as T;
      const e = (r.body as ApiErrorBody | null)?.error;
      if (e?.code === "step_up_required" && attempt === 0) {
        await this.stepUp();
        continue;
      }
      throw new ApiFailure(`${method} ${path}`, r.status, e?.code, e?.message);
    }
  }

  /** `GET /v1/auth/session` (spec 0.1.5): the session behind the cookie, with its CSRF token. */
  async session(): Promise<{ user: { email: string }; account: { id: string; display_name: string } } | null> {
    const r = await this.raw("GET", "/v1/auth/session");
    if (r.status === 401) return null;
    if (r.status !== 200) {
      const e = (r.body as ApiErrorBody | null)?.error;
      throw new ApiFailure("GET /v1/auth/session", r.status, e?.code, e?.message);
    }
    const s = r.body as { csrf_token: string; user: { email: string }; account: { id: string; display_name: string } };
    this.csrf = s.csrf_token;
    return s;
  }

  /** Passkey assertion with the virtual authenticator for an options route, posted to its verify route. */
  private async assert(optionsPath: string, verifyPath: string, optionsBody: unknown): Promise<unknown> {
    const options = await this.call<unknown>("POST", optionsPath, { body: optionsBody });
    const credential = await this.page.evaluate(async (o) => {
      const pk = PublicKeyCredential.parseRequestOptionsFromJSON(o as PublicKeyCredentialRequestOptionsJSON);
      const c = (await navigator.credentials.get({ publicKey: pk })) as PublicKeyCredential | null;
      if (!c) throw new Error("no credential");
      return c.toJSON();
    }, options);
    const r = await this.call<unknown>("POST", verifyPath, { body: { credential } });
    await this.afterAssertion?.();
    return r;
  }

  async signIn(email: string): Promise<void> {
    await this.assert("/v1/auth/passkeys/authentication/options", "/v1/auth/passkeys/authentication/verify", {
      email,
    });
  }

  async stepUp(): Promise<void> {
    await this.assert("/v1/auth/step_up/options", "/v1/auth/step_up/verify", {});
  }
}

// ---------------------------------------------------------------------------------------------
// Mailpit (read through the browser: Chrome resolves *.localhost and trusts the pinned certificate)
// ---------------------------------------------------------------------------------------------

async function magicLink(b: Browser, mailUrl: string, dashboardUrl: string, to: string, since: number) {
  const pattern = new RegExp(`${dashboardUrl.replace(/[.]/g, "\\.")}/auth/verify#token=[A-Za-z0-9_-]+`);
  const reader = await b.context.newPage();
  try {
    const get = async (url: string) => {
      const r = await reader.goto(url);
      if (!r?.ok()) throw new Error(`Mailpit ${r?.status() ?? "unreachable"} for ${url}`);
      return r.json();
    };
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const list = (await get(`${mailUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`)) as {
        messages: { ID: string; Created: string }[];
      };
      const fresh = list.messages
        .filter((m) => Date.parse(m.Created) >= since - 30_000)
        .sort((a, b) => Date.parse(b.Created) - Date.parse(a.Created));
      for (const m of fresh) {
        const full = (await get(`${mailUrl}/api/v1/message/${m.ID}`)) as { Text?: string };
        const link = pattern.exec(full.Text ?? "")?.[0];
        if (link) return link;
      }
      await sleep(1500);
    }
    throw new Error(`no sign-up link for ${to} in Mailpit (${mailUrl}) after 90 s`);
  } finally {
    await reader.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------

interface Ctx {
  o: OnboardOptions;
  b: Browser;
  api: DashboardApi;
  key: MerchantKey;
  state: OnboardState;
  passkey: PasskeyRecord | null;
  dashboardUrl: string;
  mailUrl: string;
}

const ops = (c: Ctx, service: string, argv: string[]) => serviceOps({ deployDir: c.o.deployDir }, service, argv);
const opsCli = (c: Ctx, argv: string[]) => {
  let out = "";
  const code = runCli(argv, { deployDir: c.o.deployDir, out: (s) => (out += s), err: (s) => (out += s) });
  if (code !== 0) throw new Error(`pnpm ops ${argv[0]} failed (${code}): ${out.trim().slice(0, 400)}`);
};

/** The account behind an email per identity's ops CLI: id, or null when there is no such user. */
function accountByEmail(c: Ctx, email: string): string | null {
  const r = ops(c, "identity-api", ["account-show", email]);
  if (r.code === 127) throw new Error("docker is not available; start the stack with nearpay-deploy/scripts/up.sh");
  if (r.code !== 0) {
    if (/resource_missing|No such user/.test(r.stdout + r.stderr)) return null;
    throw new Error(`ops account-show failed (${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  }
  return (r.json as { id?: string } | undefined)?.id ?? null;
}

function savePasskeyNow(c: Ctx, list: readonly VirtualCredential[]) {
  const cred = pickCredential(list, c.passkey?.credential.credentialId);
  if (!cred) throw new Error(`expected one passkey in the virtual authenticator, found ${list.length}`);
  c.passkey = passkeyRecord(c.o.email, cred);
  savePasskey(c.o.passkeyFile, c.passkey);
}

async function signUp(c: Ctx): Promise<void> {
  const { page } = c.b;
  log(`      no saved passkey: signing up ${c.o.email}`);
  const since = Date.now();
  await page.goto(`${c.dashboardUrl}/signup`);
  await page.getByLabel("Work email").fill(c.o.email);
  await page.getByRole("button", { name: "Email me a sign-up link" }).click();
  await page.getByRole("heading", { name: "Check your email" }).waitFor({ timeout: 30_000 });
  const link = await magicLink(c.b, c.mailUrl, c.dashboardUrl, c.o.email, since);
  log("      magic link received (Mailpit); creating the passkey");
  await page.goto(link);
  await page.getByText("Email verified").waitFor({ timeout: 30_000 });
  await page.getByLabel("Business name").fill(c.o.business);
  await page.getByRole("button", { name: "Create passkey and open dashboard" }).click();
  // the shell keeps the account name in a hidden element: wait for it to be attached, not visible
  await page.getByTestId("account-name").waitFor({ state: "attached", timeout: 30_000 });
  // keep the credential before anything else can fail: without it the account cannot sign in again
  savePasskeyNow(c, await credentials(c.b));
  log(`      passkey saved to ${c.o.passkeyFile} (0600)`);
}

async function signIn(c: Ctx, saved: PasskeyRecord): Promise<boolean> {
  await c.b.cdp.send("WebAuthn.addCredential", {
    authenticatorId: c.b.authenticatorId,
    credential: credentialForReuse(saved) as never,
  });
  await c.b.page.goto(`${c.dashboardUrl}/signin`);
  try {
    await c.api.signIn(c.o.email);
    return true;
  } catch (e) {
    if (e instanceof ApiFailure && (e.code === "webauthn_failed" || e.status === 400 || e.status === 401)) {
      log(`      the saved passkey was not accepted (${e.code ?? e.status})`);
      return false;
    }
    throw e;
  }
}

/** 1. Signed-in dashboard session for the merchant (sign-up on the first run). */
async function ensureAccount(c: Ctx): Promise<{ accountId: string; displayName: string }> {
  step(1, `account ${c.o.email}`);
  await c.b.page.goto(`${c.dashboardUrl}/signin`);
  const saved = c.passkey;
  if (saved) {
    if (saved.email !== c.o.email) {
      throw new Error(
        `${c.o.passkeyFile} holds the passkey of ${saved.email}; run with --email ${saved.email} or another --passkey`,
      );
    }
    if (!(await signIn(c, saved))) {
      if (accountByEmail(c, c.o.email)) {
        throw new Error(
          `${c.o.email} exists but rejects the saved passkey (${c.o.passkeyFile}); ` +
            "restore the matching passkey file or onboard another --email",
        );
      }
      // the stack was reset: the saved passkey belongs to an account that no longer exists
      const stale = `${c.o.passkeyFile}.stale-${Date.now()}`;
      renameSync(c.o.passkeyFile, stale);
      log(`      ${c.o.email} no longer exists on this stack; old passkey moved to ${stale}`);
      await c.b.cdp.send("WebAuthn.clearCredentials", { authenticatorId: c.b.authenticatorId });
      c.passkey = null;
      c.state = {};
      await signUp(c);
    } else {
      log("      saved passkey accepted");
    }
  } else {
    if (accountByEmail(c, c.o.email)) {
      throw new Error(
        `${c.o.email} already has an account but there is no saved passkey at ${c.o.passkeyFile}; ` +
          "sign-up cannot be repeated for an existing user. Restore the passkey file or use another --email",
      );
    }
    await signUp(c);
  }
  await c.b.page.goto(`${c.dashboardUrl}/`);
  await c.b.page.getByTestId("account-name").waitFor({ state: "attached", timeout: 30_000 });
  const s = await c.api.session();
  if (!s) throw new Error("signed in, but the dashboard has no session");
  // a resident passkey names its own user: never carry on as someone other than --email
  if (s.user.email.toLowerCase() !== c.o.email) {
    throw new Error(`the saved passkey signs in as ${s.user.email}, not ${c.o.email}; check --email and --passkey`);
  }
  if (c.state.account_id && c.state.account_id !== s.account.id) c.state = {};
  c.state.email = c.o.email;
  c.state.account_id = s.account.id;
  saveState(c.o.stateFile, c.state);
  log(`      account ${s.account.id}`);
  return { accountId: s.account.id, displayName: s.account.display_name };
}

/** 2. Display name follows --business. */
async function ensureName(c: Ctx, current: string): Promise<void> {
  if (current === c.o.business) {
    step(2, `business name "${current}" (unchanged)`);
    return;
  }
  step(2, `business name "${current}" → "${c.o.business}"`);
  await c.api.call("PATCH", "/v1/account", { body: { display_name: c.o.business }, idempotent: true });
}

interface Destination extends DestinationLike {
  fingerprint: string;
  is_default: boolean;
  attestation_challenge?: {
    id: string;
    message: string;
    nonce?: string;
    recipient?: string;
    signing_standard: string;
    expires_at: number;
  };
}

/** 3–4. Live USDC Intents destination for the merchant key, attested and active. */
async function ensureDestination(c: Ctx, accountId: string): Promise<Destination> {
  const list = await c.api.call<{ data: Destination[] }>("GET", "/v1/settlement_destinations?limit=100");
  let d = findDestination(list.data, c.key.accountId, USDC_NEAR);
  if (!d) {
    step(3, `destination: creating a live USDC NEAR Intents destination for ${c.key.accountId}`);
    d = await c.api.call<Destination>("POST", "/v1/settlement_destinations", {
      idempotent: true,
      body: {
        asset_id: USDC_NEAR,
        type: "intents_account",
        chain: "near:mainnet",
        address: c.key.accountId,
        label: "Demo payouts (USDC)",
      },
    });
  } else {
    step(3, `destination ${d.id} (${d.status})`);
  }
  c.state.destination_id = d.id;
  saveState(c.o.stateFile, c.state);

  if (d.status === "pending_verification") {
    let ch = d.attestation_challenge;
    if (!ch || ch.expires_at <= Date.now() / 1000 + 30) {
      log("      requesting a fresh attestation challenge");
      d = await c.api.call<Destination>("POST", `/v1/settlement_destinations/${d.id}/challenge`, {
        idempotent: true,
        body: {},
      });
      ch = d.attestation_challenge;
    }
    if (ch?.signing_standard !== "nep413" || !ch.nonce || !ch.recipient) {
      throw new Error(`destination ${d.id}: no NEP-413 attestation challenge to sign`);
    }
    // sign only the attestation for this account and this address (identity §8.2 message)
    if (!ch.message.includes(`Address: ${c.key.accountId}`) || !ch.message.includes(`Account: ${accountId}`)) {
      throw new Error(`destination ${d.id}: the challenge does not name ${accountId} and ${c.key.accountId}`);
    }
    const signed = signNep413(c.key, { message: ch.message, recipient: ch.recipient, nonce: ch.nonce });
    d = await c.api.call<Destination>("POST", `/v1/settlement_destinations/${d.id}/attest`, {
      idempotent: true,
      body: { challenge_id: ch.id, standard: "nep413", ...signed },
    });
    log(`      attestation verified (NEP-413, ${c.key.publicKey}) → ${d.status}`);
  }
  if (d.status === "pending_approval") {
    throw new Error(`destination ${d.id} awaits a compliance approval (pending_approval); re-run once approved`);
  }
  if (d.status === "cooling_off") {
    step(4, `cool-off: ops destination-cooloff-skip ${d.id}`);
    opsCli(c, ["destination-cooloff-skip", d.id]);
    const deadline = Date.now() + 90_000;
    while (d.status !== "active" && Date.now() < deadline) {
      await sleep(2000);
      d = await c.api.call<Destination>("GET", `/v1/settlement_destinations/${d.id}`);
    }
  } else {
    step(4, `activation: ${d.status === "active" ? "active (no cool-off on this stack)" : d.status}`);
  }
  if (d.status !== "active") throw new Error(`destination ${d.id} is ${d.status}, expected active`);
  if (!d.is_default) {
    log("      making it the default destination");
    d = await c.api.call<Destination>("POST", `/v1/settlement_destinations/${d.id}/set_default`, {
      idempotent: true,
      body: {},
    });
  }
  return d;
}

interface Account {
  id: string;
  kyb_status: string;
  live_enabled: boolean;
  status: string;
}

/**
 * 5. Business details declared and submitted → compliance decides at once (NP_KYB_MODE=auto,
 * ADR-0024) → live_enabled. `--kyb-mode manual` decides a pending case with the ops CLI.
 */
async function ensureLive(c: Ctx, accountId: string): Promise<void> {
  let a = await c.api.call<Account>("GET", "/v1/account");
  if (a.live_enabled) {
    step(5, `KYB ${a.kyb_status}, live_enabled`);
    return;
  }
  step(5, `KYB ${a.kyb_status} (NP_KYB_MODE=${c.o.kybMode})`);
  let kyb = await c.api.call<{ status: string }>("GET", "/v1/account/kyb");
  let next = kybStep(kyb.status, c.o.kybMode);
  if (next === "rejected") {
    throw new Error(`KYB of ${accountId} was rejected; reverse it in the console (Businesses) if that was a mistake`);
  }
  if (next === "submit") {
    await c.api.call("PATCH", "/v1/account/kyb", { body: demoKybProfile(c.o.business, c.o.country) });
    kyb = await c.api.call<{ status: string }>("POST", "/v1/account/kyb/submit", {
      idempotent: true,
      body: { declaration: true },
    });
    log(`      business details submitted → ${kyb.status}`);
    next = kybStep(kyb.status, c.o.kybMode);
    if (next === "rejected") throw new Error(`KYB of ${accountId} was rejected automatically (geo policy?)`);
  }
  if (next === "decide") {
    log("      manual review mode: ops kyb-decide approved");
    opsCli(c, ["kyb-decide", accountId, "approved", "--reason", "demo merchant (pnpm onboard:live)"]);
  }
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    a = await c.api.call<Account>("GET", "/v1/account");
    if (a.live_enabled) break;
    await sleep(2000);
  }
  if (!a.live_enabled)
    throw new Error(
      `account ${accountId} is not live_enabled (kyb ${a.kyb_status}, ${a.status})${
        a.kyb_status === "pending" ? "; compliance may run NP_KYB_MODE=manual: rerun with --kyb-mode manual" : ""
      }`,
    );
  log("      live_enabled");
}

interface ApiKey {
  id: string;
  type: string;
  livemode: boolean;
  name: string;
  display_prefix: string;
  last4: string;
  secret?: string;
}

/** 6. Live secret key in merchant-demo's secret_key file. */
async function ensureLiveKey(c: Ctx): Promise<{ id: string; prefix: string; created: boolean }> {
  const file = join(c.o.secretsDir, "secret_key");
  const keys = await c.api.call<{ data: ApiKey[] }>("GET", "/v1/api_keys?limit=100");
  const have = keyInFile(keys.data, readSecret(file));
  if (have) {
    step(6, `live secret key ${have.id} already in ${file}`);
    c.state.api_key_id = have.id;
    saveState(c.o.stateFile, c.state);
    return { id: have.id, prefix: `${have.display_prefix}…`, created: false };
  }
  step(6, "live secret key: creating");
  const k = await c.api.call<ApiKey>("POST", "/v1/api_keys", {
    idempotent: true,
    body: { type: "secret", name: KEY_NAME, livemode: true },
  });
  if (!k.secret?.startsWith("sk_live_")) throw new Error(`POST /v1/api_keys returned no live secret (key ${k.id})`);
  writePrivateFile(file, `${k.secret}\n`);
  c.state.api_key_id = k.id;
  saveState(c.o.stateFile, c.state);
  log(`      ${keyPrefix(k.secret)} (${k.id}) written to ${file} (0600)`);
  return { id: k.id, prefix: keyPrefix(k.secret), created: true };
}

interface Endpoint {
  id: string;
  url: string;
  livemode: boolean;
  status: string;
  enabled_events: string[];
  secret?: string;
}

/** 7. Live webhook endpoint for all events; its secret appended to webhook_secret. */
async function ensureWebhook(c: Ctx): Promise<{ id: string; created: boolean }> {
  const file = join(c.o.secretsDir, "webhook_secret");
  const list = await c.api.call<{ data: Endpoint[] }>("GET", "/v1/webhook_endpoints?limit=100");
  const same = list.data.filter((e) => e.livemode && e.url === c.o.webhookUrl);
  const known = same.find((e) => e.id === c.state.webhook_endpoint_id);
  if (known && hasSecretHash(file, c.state.webhook_secret_sha256)) {
    step(7, `live webhook endpoint ${known.id} (${known.status}), signing secret in ${file}`);
    if (known.status !== "enabled") {
      await c.api.call("PATCH", `/v1/webhook_endpoints/${known.id}`, { idempotent: true, body: { disabled: false } });
      log("      re-enabled");
    }
    return { id: known.id, created: false };
  }
  step(7, `live webhook endpoint: creating ${c.o.webhookUrl} (all events)`);
  if (known) {
    // created by an earlier run, but its signing secret is not in this file and is shown only once
    log(`      ${known.id} (earlier run) has no signing secret in ${file}: deleting it`);
    await c.api.call("DELETE", `/v1/webhook_endpoints/${known.id}`);
  }
  const others = same.filter((e) => e.id !== known?.id).map((e) => e.id);
  if (others.length) log(`      note: ${others.join(", ")} also deliver to this URL (not created by this script)`);
  const ep = await c.api.call<Endpoint>("POST", "/v1/webhook_endpoints", {
    idempotent: true,
    body: { url: c.o.webhookUrl, enabled_events: ["*"], description: "merchant-demo (pnpm onboard:live)" },
  });
  if (!ep.secret) throw new Error(`POST /v1/webhook_endpoints returned no signing secret (endpoint ${ep.id})`);
  const r = appendSecret(file, ep.secret);
  c.state.webhook_endpoint_id = ep.id;
  c.state.webhook_secret_sha256 = sha256Hex(ep.secret);
  saveState(c.o.stateFile, c.state);
  log(`      signing secret appended to ${file} (${r.count} secret${r.count === 1 ? "" : "s"}, 0600)`);
  return { id: ep.id, created: true };
}

/**
 * merchant-demo reads the secret files through a bind mount as uid 10001. Docker Desktop (macOS)
 * serves 0600 files of the host user to it; a Linux host does not. When the container is running
 * and cannot read a file, the file gets seed.sh's mode 0644 instead (the directory stays as it is).
 */
function ensureContainerCanRead(c: Ctx, names: readonly string[]): void {
  const mounted = join(c.o.deployDir, ".secrets/merchant-demo");
  if (c.o.secretsDir !== mounted) return; // not the directory merchant-demo mounts
  const ps = spawnSync("docker", ["compose", "-p", "nearpay", "ps", "-q", "merchant-demo"], { encoding: "utf8" });
  const id = ps.status === 0 ? ps.stdout.trim().split("\n")[0] : "";
  if (!id) {
    log("      merchant-demo is not running; it reads the files when it starts");
    return;
  }
  const probe = `const fs=require("fs");for(const f of ${JSON.stringify(names)}){try{fs.accessSync("/run/secrets/merchant-demo/"+f,fs.constants.R_OK)}catch{console.log(f)}}`;
  const r = spawnSync("docker", ["exec", id, "/nodejs/bin/node", "-e", probe], { encoding: "utf8" });
  if (r.status !== 0) {
    log(`      warning: could not check that merchant-demo can read the files (${r.stderr.trim().slice(0, 200)})`);
    return;
  }
  for (const name of r.stdout.split("\n").filter((n) => names.includes(n))) {
    chmodSync(join(c.o.secretsDir, name), 0o644);
    log(`      ${name}: merchant-demo (uid 10001) cannot read a 0600 file on this host; set to 0644 like seed.sh`);
  }
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

export async function onboard(o: OnboardOptions): Promise<number> {
  if (!existsSync(o.merchantKeyFile)) {
    throw new Error(`no merchant key at ${o.merchantKeyFile} (near-cli JSON; --merchant-key or NP_MERCHANT_KEY_FILE)`);
  }
  const key = parseMerchantKey(readFileSync(o.merchantKeyFile, "utf8"), o.merchantKeyFile);
  const st = stackFromEnv({ ...process.env, NP_DEPLOY_DIR: o.deployDir });
  const mailUrl = st.dashboardUrl.replace("://dashboard.", "://mail.");
  log(`NearPay live onboarding — ${st.dashboardUrl}`);
  log(`      merchant payout account ${key.accountId} (${o.merchantKeyFile})`);
  const b = await openBrowser(o);
  const c: Ctx = {
    o,
    b,
    api: new DashboardApi(b.page),
    key,
    state: loadState(o.stateFile),
    passkey: loadPasskey(o.passkeyFile),
    dashboardUrl: st.dashboardUrl,
    mailUrl,
  };
  c.api.afterAssertion = async () => savePasskeyNow(c, await credentials(b));
  try {
    const acct = await ensureAccount(c);
    await ensureName(c, acct.displayName);
    const d = await ensureDestination(c, acct.accountId);
    await ensureLive(c, acct.accountId);
    const k = await ensureLiveKey(c);
    const w = await ensureWebhook(c);
    ensureContainerCanRead(c, ["secret_key", "webhook_secret"]);
    log("");
    log("Merchant onboarded (live)");
    log(`  email           ${o.email}`);
    log(`  account         ${acct.accountId}`);
    log(`  destination     ${d.id}  fingerprint ${d.fingerprint}  (${d.status}, USDC → ${key.accountId})`);
    log(`  live key        ${k.prefix}  ${k.id}${k.created ? "  (new)" : ""}  → ${join(o.secretsDir, "secret_key")}`);
    log(
      `  webhook         ${w.id}${w.created ? "  (new)" : ""}  ${o.webhookUrl}  → ${join(o.secretsDir, "webhook_secret")}`,
    );
    log(`  passkey         ${o.passkeyFile}`);
    log("merchant-demo picks up both files within 5 s.");
    return 0;
  } finally {
    // keep the saved sign counter in step with the server (a lower counter fails the next sign-in);
    // also keeps a passkey registered by a run that failed right after creating it
    try {
      const list = await credentials(b);
      if (list.length > 0) savePasskeyNow(c, list);
    } catch (e) {
      log(`warning: could not refresh ${o.passkeyFile}: ${(e as Error).message}`);
    }
    await b.close();
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  let o: OnboardOptions;
  try {
    o = parseOnboardArgs(process.argv.slice(2), process.env);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${ONBOARD_USAGE}\n`);
    process.exit(2);
  }
  if (o.help) {
    log(ONBOARD_USAGE);
    process.exit(0);
  }
  onboard(o).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`\nonboarding stopped: ${e instanceof Error ? e.message : String(e)}\n`);
      process.stderr.write("Fix the cause and run it again; it continues from where it stopped.\n");
      process.exit(1);
    },
  );
}
