/**
 * merchant-demo configuration (lld/platform.md §1 `merchant-demo`, §3). Secrets are read lazily from
 * files so the container can start before `nearpay-deploy/scripts/seed.sh data` has created the demo
 * merchant: the API key and webhook secret appear in `NP_DEMO_SECRETS_DIR` afterwards and are picked
 * up without a restart. Environment variables override the files (local development).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Config {
  env: string;
  port: number;
  /** Public NearPay API origin as seen from this container (`https://api.nearpay.localhost`). */
  apiBase: string;
  /** This demo's public origin (success URL, x402 resource URLs). */
  publicUrl: string;
  /** Checkout amount in USD cents (demo script: USD 2.00). */
  checkoutAmount: number;
  /** x402 price of `GET /premium` in base units of the asset (default 0.01 USDC). */
  premiumAmount: string;
  premiumAsset: string | undefined;
  secrets: Secrets;
}

export interface Secrets {
  /** `sk_test_…` / `sk_live_…` of the demo merchant, or null until seeded. */
  secretKey(): string | null;
  /** Webhook endpoint signing secrets (`whsec_…`; several during rotation). */
  webhookSecrets(): string[];
}

type Env = Record<string, string | undefined>;

/** Default public URL: the API host with `api.` replaced by `merchant-demo.` (Traefik route). */
export function defaultPublicUrl(apiBase: string): string {
  const u = new URL(apiBase);
  u.hostname = u.hostname.replace(/^api\./, "merchant-demo.");
  return u.origin;
}

export function fileSecrets(env: Env, now: () => number = Date.now, ttlMs = 5_000): Secrets {
  const dir = env.NP_DEMO_SECRETS_DIR ?? "/run/secrets/merchant-demo";
  const cache = new Map<string, { at: number; value: string | null }>();
  const read = (envName: string, file: string): string | null => {
    const fromEnv = env[envName]?.trim();
    if (fromEnv) return fromEnv;
    const hit = cache.get(file);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const path = join(dir, file);
    const value = existsSync(path) ? readFileSync(path, "utf8").trim() || null : null;
    cache.set(file, { at: now(), value });
    return value;
  };
  return {
    secretKey: () => read("NP_DEMO_SECRET_KEY", "secret_key"),
    webhookSecrets: () =>
      (read("NP_DEMO_WEBHOOK_SECRET", "webhook_secret") ?? "").split(/[\s,]+/).filter((s) => s.length > 0),
  };
}

export function readConfig(env: Env = process.env): Config {
  const apiBase = (env.NP_PUBLIC_API_URL ?? "https://api.nearpay.localhost").replace(/\/$/, "");
  const port = Number(env.PORT ?? "3000");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("PORT must be a TCP port");
  const checkoutAmount = Number(env.NP_DEMO_CHECKOUT_AMOUNT ?? "200");
  if (!Number.isSafeInteger(checkoutAmount) || checkoutAmount <= 0) {
    throw new Error("NP_DEMO_CHECKOUT_AMOUNT must be a positive number of cents");
  }
  const premiumAmount = env.NP_DEMO_PREMIUM_AMOUNT ?? "10000";
  if (!/^[1-9][0-9]*$/.test(premiumAmount)) throw new Error("NP_DEMO_PREMIUM_AMOUNT must be base units");
  return {
    env: env.NP_ENV ?? "local",
    port,
    apiBase,
    publicUrl: (env.NP_DEMO_PUBLIC_URL ?? defaultPublicUrl(apiBase)).replace(/\/$/, ""),
    checkoutAmount,
    premiumAmount,
    premiumAsset: env.NP_DEMO_PREMIUM_ASSET || undefined,
    secrets: fileSecrets(env),
  };
}
