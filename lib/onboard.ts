/**
 * Pure helpers of the live merchant onboarding script (`pnpm onboard:live`, scripts/onboard-live.ts):
 * the merchant NEAR key (near-cli JSON of an implicit account), NEP-413 signing with it, the saved
 * virtual-authenticator passkey, the onboarding state file, the merchant-demo secret files and the
 * command-line options. Nothing here prints or returns key material in an error message.
 *
 * Secret files are written with mode 0600 (directories 0700) through a temporary file and a rename,
 * so a crash never leaves a half-written key behind.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { nep413Hash } from "@nearpay-money/agent-signer";
import { ed25519 } from "@noble/curves/ed25519.js";

export const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const DEFAULT_EMAIL = "demo-merchant@nearpay.localhost";
export const DEFAULT_BUSINESS = "NearPay Demo Store";
export const DEFAULT_WEBHOOK_URL = "http://merchant-demo:3000/webhooks";
/** Name of the live secret key the script creates (and recognises on a re-run). */
export const KEY_NAME = "merchant-demo (onboard:live)";

// ---------------------------------------------------------------------------------------------
// base58 (NEAR keys)
// ---------------------------------------------------------------------------------------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) throw new Error("not base58");
    n = n * 58n + BigInt(v);
  }
  const hex = n === 0n ? "" : n.toString(16);
  const body = Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex");
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  return Uint8Array.from([...new Uint8Array(zeros), ...body]);
}

// ---------------------------------------------------------------------------------------------
// Merchant NEAR key
// ---------------------------------------------------------------------------------------------

export interface MerchantKey {
  /** Implicit account: lower-case hex of the public key. */
  accountId: string;
  /** `ed25519:<base58>`. */
  publicKey: string;
  /** 32-byte ed25519 seed. Never printed. */
  seed: Uint8Array;
}

/**
 * Parses near-cli key JSON (`{account_id, public_key, private_key}`; near-cli-rs also writes
 * `implicit_account_id`, older tools `secret_key`). The account must be the implicit account of the
 * key (identity §8.2 checks `hex(pubkey) == address` without RPC), so payouts go to this account.
 */
export function parseMerchantKey(text: string, source = "merchant key"): MerchantKey {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${source}: not JSON (expected near-cli {account_id, public_key, private_key})`);
  }
  if (!j || typeof j !== "object") throw new Error(`${source}: not a JSON object`);
  const str = (k: string) => (typeof j[k] === "string" ? (j[k] as string).trim() : undefined);
  const accountId = str("account_id") ?? str("implicit_account_id");
  const priv = str("private_key") ?? str("secret_key");
  if (!accountId) throw new Error(`${source}: missing account_id`);
  if (!priv) throw new Error(`${source}: missing private_key`);
  if (!priv.startsWith("ed25519:")) throw new Error(`${source}: private_key must be an ed25519:… key`);
  let raw: Uint8Array;
  try {
    raw = base58Decode(priv.slice("ed25519:".length));
  } catch {
    throw new Error(`${source}: private_key is not base58`);
  }
  if (raw.length !== 64 && raw.length !== 32) throw new Error(`${source}: private_key has an unexpected length`);
  const seed = raw.slice(0, 32);
  const pub = ed25519.getPublicKey(seed);
  if (raw.length === 64 && !Buffer.from(raw.slice(32)).equals(Buffer.from(pub))) {
    throw new Error(`${source}: private_key does not match its embedded public key`);
  }
  const publicKey = `ed25519:${base58Encode(pub)}`;
  const declared = str("public_key");
  if (declared && declared !== publicKey) throw new Error(`${source}: public_key does not match private_key`);
  const implicit = Buffer.from(pub).toString("hex");
  if (accountId !== implicit) {
    throw new Error(
      `${source}: account_id ${accountId} is not the implicit account of this key (${implicit}); ` +
        "the onboarding script needs an implicit account so the attestation verifies offline",
    );
  }
  return { accountId, publicKey, seed };
}

/** Writes a fresh implicit-account key in near-cli JSON (test fixtures; mode 0600). */
export function generateMerchantKey(path: string, seed: Uint8Array = ed25519.utils.randomSecretKey()): MerchantKey {
  const pub = ed25519.getPublicKey(seed);
  const key: MerchantKey = {
    accountId: Buffer.from(pub).toString("hex"),
    publicKey: `ed25519:${base58Encode(pub)}`,
    seed,
  };
  const privateKey = `ed25519:${base58Encode(Uint8Array.from([...seed, ...pub]))}`;
  writePrivateFile(
    path,
    `${JSON.stringify({ account_id: key.accountId, public_key: key.publicKey, private_key: privateKey }, null, 2)}\n`,
  );
  return key;
}

/** NEP-413 signature (base64) of an attestation challenge with the merchant key. */
export function signNep413(
  key: MerchantKey,
  c: { message: string; recipient: string; nonce: string },
): { signature: string; public_key: string } {
  const hash = nep413Hash(c.message, Uint8Array.from(Buffer.from(c.nonce, "base64")), c.recipient);
  return { signature: Buffer.from(ed25519.sign(hash, key.seed)).toString("base64"), public_key: key.publicKey };
}

// ---------------------------------------------------------------------------------------------
// Private files
// ---------------------------------------------------------------------------------------------

/** Writes `content` to `path` with mode 0600 (parent directories 0700) via a temporary file. */
export function writePrivateFile(path: string, content: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

/** File mode bits (e.g. 0o600), or null when the file does not exist. */
export function fileMode(path: string): number | null {
  return existsSync(path) ? statSync(path).mode & 0o777 : null;
}

/** Secrets of a comma/whitespace-separated secret file (merchant-demo `webhook_secret`). */
export function readSecretList(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/[\s,]+/)
    .filter((s) => s.length > 0);
}

/**
 * Appends `secret` to a comma-separated secret file, keeping every existing entry (merchant-demo
 * accepts any of them during rotation). Already present: the file is left as it is.
 */
export function appendSecret(path: string, secret: string): { added: boolean; count: number } {
  if (!/^[\x21-\x7e]+$/.test(secret) || secret.includes(",")) throw new Error("refusing to append a malformed secret");
  const list = readSecretList(path);
  if (list.includes(secret)) return { added: false, count: list.length };
  list.push(secret);
  writePrivateFile(path, `${list.join(",")}\n`);
  return { added: true, count: list.length };
}

/** The single-line secret in `path`, or null. */
export function readSecret(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8").trim() || null : null;
}

// ---------------------------------------------------------------------------------------------
// Saved passkey (CDP virtual authenticator credential)
// ---------------------------------------------------------------------------------------------

/** `WebAuthn.Credential` of the Chrome DevTools Protocol (base64 fields, PKCS#8 private key). */
export interface VirtualCredential {
  credentialId: string;
  isResidentCredential: boolean;
  rpId?: string;
  privateKey: string;
  userHandle?: string;
  signCount: number;
  [extra: string]: unknown;
}

export interface PasskeyRecord {
  version: 1;
  email: string;
  rp_id: string;
  credential: VirtualCredential;
  saved_at: string;
}

const B64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

export function passkeyRecord(email: string, credential: VirtualCredential, now: Date = new Date()): PasskeyRecord {
  return { version: 1, email, rp_id: credential.rpId ?? "", credential, saved_at: now.toISOString() };
}

function checkCredential(c: unknown, source: string): VirtualCredential {
  const v = c as Partial<VirtualCredential> | null;
  if (!v || typeof v !== "object") throw new Error(`${source}: missing credential`);
  if (typeof v.credentialId !== "string" || !B64.test(v.credentialId)) throw new Error(`${source}: bad credentialId`);
  if (typeof v.privateKey !== "string" || !B64.test(v.privateKey)) throw new Error(`${source}: bad privateKey`);
  if (typeof v.isResidentCredential !== "boolean") throw new Error(`${source}: bad isResidentCredential`);
  if (!Number.isSafeInteger(v.signCount) || (v.signCount as number) < 0) throw new Error(`${source}: bad signCount`);
  if (v.isResidentCredential && (typeof v.rpId !== "string" || !v.rpId)) {
    throw new Error(`${source}: a resident credential needs its rpId`);
  }
  return v as VirtualCredential;
}

/** The saved passkey, or null when there is none. Malformed files throw (never overwritten silently). */
export function loadPasskey(path: string): PasskeyRecord | null {
  if (!existsSync(path)) return null;
  let j: Partial<PasskeyRecord>;
  try {
    j = JSON.parse(readFileSync(path, "utf8")) as Partial<PasskeyRecord>;
  } catch {
    throw new Error(`${path}: not JSON`);
  }
  if (j.version !== 1) throw new Error(`${path}: unsupported version`);
  if (typeof j.email !== "string" || !j.email.includes("@")) throw new Error(`${path}: missing email`);
  const credential = checkCredential(j.credential, path);
  return {
    version: 1,
    email: j.email,
    rp_id: typeof j.rp_id === "string" ? j.rp_id : (credential.rpId ?? ""),
    credential,
    saved_at: typeof j.saved_at === "string" ? j.saved_at : "",
  };
}

export function savePasskey(path: string, record: PasskeyRecord): void {
  checkCredential(record.credential, "passkey");
  writePrivateFile(path, `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * The credential the authenticator holds now for the saved one (same id), so the saved sign counter
 * never falls behind the server's (a lower counter fails the next assertion).
 */
export function pickCredential(list: readonly VirtualCredential[], credentialId?: string): VirtualCredential | null {
  if (credentialId) return list.find((c) => c.credentialId === credentialId) ?? null;
  return list.length === 1 ? (list[0] as VirtualCredential) : null;
}

/**
 * Assertions a run may make without the saved counter catching up (a run killed after an assertion
 * the server accepted but before the file was rewritten).
 */
export const SIGN_COUNT_MARGIN = 16;

/**
 * The saved credential for `WebAuthn.addCredential`, its counter moved ahead by `margin`. Identity
 * (SimpleWebAuthn) refuses an assertion whose counter is not above the stored one; skipping ahead is
 * allowed, so a counter that fell behind after an interrupted run still signs in.
 */
export function credentialForReuse(record: PasskeyRecord, margin = SIGN_COUNT_MARGIN): VirtualCredential {
  return { ...record.credential, signCount: record.credential.signCount + margin };
}

// ---------------------------------------------------------------------------------------------
// Onboarding state (ids only, no secrets)
// ---------------------------------------------------------------------------------------------

export interface OnboardState {
  email?: string;
  account_id?: string;
  destination_id?: string;
  api_key_id?: string;
  /** Live endpoint whose signing secret is in merchant-demo's `webhook_secret`. */
  webhook_endpoint_id?: string;
  /** SHA-256 (hex) of that signing secret, to find it in the file again (the secret itself is not kept). */
  webhook_secret_sha256?: string;
}

export function loadState(path: string): OnboardState {
  if (!existsSync(path)) return {};
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const out: OnboardState = {};
    const keys = [
      "email",
      "account_id",
      "destination_id",
      "api_key_id",
      "webhook_endpoint_id",
      "webhook_secret_sha256",
    ] as const;
    for (const k of keys) {
      if (typeof j[k] === "string") out[k] = j[k] as string;
    }
    return out;
  } catch {
    throw new Error(`${path}: not JSON`);
  }
}

export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

/** Whether the secret file holds the secret with this SHA-256. */
export function hasSecretHash(path: string, hash: string | undefined): boolean {
  return !!hash && readSecretList(path).some((s) => sha256Hex(s) === hash);
}

export function saveState(path: string, state: OnboardState): void {
  writePrivateFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

// ---------------------------------------------------------------------------------------------
// API objects
// ---------------------------------------------------------------------------------------------

export interface DestinationLike {
  id: string;
  type: string;
  address: string;
  asset_id: string;
  status: string;
  livemode: boolean;
  created: number;
}

/** The merchant's live Intents-account destination for the asset (newest not disabled), if any. */
export function findDestination<D extends DestinationLike>(
  list: readonly D[],
  accountId: string,
  assetId: string = USDC_NEAR,
): D | undefined {
  return list
    .filter(
      (d) =>
        d.livemode &&
        d.type === "intents_account" &&
        d.address === accountId &&
        d.asset_id === assetId &&
        d.status !== "disabled",
    )
    .sort((a, b) => b.created - a.created)[0];
}

export interface ApiKeyLike {
  id: string;
  type: string;
  livemode: boolean;
  display_prefix: string;
  last4: string;
}

/** The live secret key whose secret is already in merchant-demo's `secret_key` file, if any. */
export function keyInFile<K extends ApiKeyLike>(keys: readonly K[], fileValue: string | null): K | undefined {
  if (!fileValue?.startsWith("sk_live_")) return undefined;
  return keys.find(
    (k) =>
      k.livemode &&
      k.type === "secret" &&
      fileValue.startsWith(k.display_prefix) &&
      fileValue.slice(-4) === k.last4 &&
      fileValue.length > k.display_prefix.length + 4,
  );
}

/** Key prefix for display: the display prefix of the key, never more of the secret. */
export function keyPrefix(secret: string): string {
  const m = /^((?:sk|pk|rk)_(?:live|test)_)/.exec(secret);
  return m ? `${m[1]}…` : "…";
}

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// KYB (open onboarding, ADR-0024)
// ---------------------------------------------------------------------------------------------

export type KybMode = "auto" | "manual";

/**
 * Self-declared demo business details for `updateKybProfile`. No registration number: it is optional
 * since ADR-0024, and the demo merchant proves that path.
 */
export function demoKybProfile(business: string, country: string) {
  return {
    legal_name: business,
    country_of_incorporation: country,
    business_type: "company" as const,
    website: null,
    business_address: { line1: "1 Demo Street", city: "Demo City", country },
    representative: { name: "Demo Owner", title: "Founder" },
    expected_monthly_volume: "under_10k" as const,
  };
}

export type KybStep = "done" | "submit" | "wait" | "decide" | "rejected";

/**
 * Next KYB step for `onboard:live`. With compliance on `NP_KYB_MODE=auto` (default) a submission is
 * decided by the system at once, so the script only submits and waits — it never calls `kyb-decide`.
 * Only `manual` (a review is turned back on) decides a pending case with the ops CLI.
 */
export function kybStep(status: string, mode: KybMode): KybStep {
  switch (status) {
    case "approved":
      return "done";
    case "rejected":
      return "rejected";
    case "pending":
      return mode === "manual" ? "decide" : "wait";
    default:
      return "submit"; // not_started, needs_info
  }
}

export interface OnboardOptions {
  email: string;
  business: string;
  /** Country of incorporation and address of the demo business (ISO 3166-1 alpha-2). */
  country: string;
  /** Compliance's `NP_KYB_MODE`: `auto` (default) never calls `kyb-decide`. */
  kybMode: KybMode;
  deployDir: string;
  merchantKeyFile: string;
  passkeyFile: string;
  stateFile: string;
  secretsDir: string;
  webhookUrl: string;
  headed: boolean;
  help: boolean;
}

export const ONBOARD_USAGE = `usage: pnpm onboard:live [options]

Onboards the demo merchant on the local stack end to end (sign-up or passkey sign-in, live NEAR
Intents destination signed with the merchant key, cool-off skip, business details (live at once in
NP_KYB_MODE=auto), live secret key, live webhook
endpoint). Safe to re-run: it continues from wherever the last run stopped.

  --email <addr>          merchant email (NP_ONBOARD_EMAIL; default ${DEFAULT_EMAIL})
  --business <name>       business name (NP_ONBOARD_BUSINESS; default "${DEFAULT_BUSINESS}")
  --country <CC>          business country, ISO alpha-2 (NP_ONBOARD_COUNTRY; default GB)
  --kyb-mode <mode>       compliance KYB mode: auto (default; live at once, no ops step) or manual
                          (decides the case with the ops CLI) (NP_KYB_MODE)
  --merchant-key <file>   near-cli key JSON of the implicit payout account
                          (NP_MERCHANT_KEY_FILE; default <deploy>/.secrets/accounts/merchant.json)
  --passkey <file>        saved passkey (NP_MERCHANT_PASSKEY_FILE;
                          default <deploy>/.secrets/accounts/merchant-passkey.json)
  --state <file>          onboarding ids (default merchant-onboard.json next to the passkey)
  --secrets-dir <dir>     merchant-demo secrets (NP_ONBOARD_SECRETS_DIR; default <deploy>/.secrets/merchant-demo)
  --webhook-url <url>     live webhook endpoint (default ${DEFAULT_WEBHOOK_URL})
  --deploy <dir>          nearpay-deploy checkout (NP_DEPLOY_DIR; default ../nearpay-deploy)
  --headed                show the browser (NP_HEADED=1)
  -h, --help`;

type Env = Record<string, string | undefined>;

export function parseOnboardArgs(argv: readonly string[], env: Env = {}, cwd = "."): OnboardOptions {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      email: { type: "string" },
      business: { type: "string" },
      country: { type: "string" },
      "kyb-mode": { type: "string" },
      "merchant-key": { type: "string" },
      passkey: { type: "string" },
      state: { type: "string" },
      "secrets-dir": { type: "string" },
      "webhook-url": { type: "string" },
      deploy: { type: "string" },
      headed: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const deployDir = resolve(cwd, values.deploy ?? env.NP_DEPLOY_DIR ?? "../nearpay-deploy");
  const accounts = join(deployDir, ".secrets/accounts");
  const email = (values.email ?? env.NP_ONBOARD_EMAIL ?? DEFAULT_EMAIL).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(email)) throw new Error(`--email: not an email address: ${email}`);
  const business = (values.business ?? env.NP_ONBOARD_BUSINESS ?? DEFAULT_BUSINESS).trim();
  if (!business || business.length > 100) throw new Error("--business: 1–100 characters");
  const country = (values.country ?? env.NP_ONBOARD_COUNTRY ?? "GB").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new Error(`--country: not an ISO 3166-1 alpha-2 code: ${country}`);
  const kybMode = (values["kyb-mode"] ?? env.NP_KYB_MODE ?? "auto").trim();
  if (kybMode !== "auto" && kybMode !== "manual") throw new Error(`--kyb-mode: auto or manual, not ${kybMode}`);
  const webhookUrl = values["webhook-url"] ?? DEFAULT_WEBHOOK_URL;
  try {
    new URL(webhookUrl);
  } catch {
    throw new Error(`--webhook-url: not a URL: ${webhookUrl}`);
  }
  const passkeyFile = resolve(
    cwd,
    values.passkey ?? env.NP_MERCHANT_PASSKEY_FILE ?? join(accounts, "merchant-passkey.json"),
  );
  return {
    email,
    business,
    country,
    kybMode,
    deployDir,
    merchantKeyFile: resolve(
      cwd,
      values["merchant-key"] ?? env.NP_MERCHANT_KEY_FILE ?? join(accounts, "merchant.json"),
    ),
    passkeyFile,
    stateFile: resolve(cwd, values.state ?? join(dirname(passkeyFile), "merchant-onboard.json")),
    secretsDir: resolve(
      cwd,
      values["secrets-dir"] ?? env.NP_ONBOARD_SECRETS_DIR ?? join(deployDir, ".secrets/merchant-demo"),
    ),
    webhookUrl,
    headed: values.headed === true || env.NP_HEADED === "1",
    help: values.help === true,
  };
}
