/**
 * Where the stack is (nearpay-deploy Compose, lld/platform.md §1) and the local test credentials.
 *
 * | Variable | Default |
 * |---|---|
 * | `NP_BASE_DOMAIN` | `nearpay.localhost` (+ `NP_HTTPS_PORT` if not 443) |
 * | `NP_API_URL`, `NP_PAY_URL`, `NP_DASHBOARD_URL`, `NP_MERCHANT_DEMO_URL` | `https://api.<domain>` … |
 * | `NP_OPS_URL` (console host), `NP_MAIL_URL` (Mailpit) | `https://ops.<domain>`, `https://mail.<domain>` |
 * | `NP_PAYER_API_URL` | `<pay URL>/api` (the checkout reaches the API same-origin, platform §1) |
 * | `NP_DEPLOY_DIR` | `../nearpay-deploy` (secrets, compose files) |
 * | `NP_SECRET_KEY` | `<deploy>/.secrets/merchant-demo/secret_key` (written by `seed.sh data`) |
 * | `NP_SENTINEL_KEYS_FILE` | `<deploy>/.secrets/public/sentinel_keys.json` (pinned sentinel keys) |
 *
 * Node must trust the local CA: `NODE_EXTRA_CA_CERTS=<deploy>/.secrets/tls/ca.pem` (the package
 * scripts set it).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type PinnedSentinelKey, parsePinnedKeys } from "@nearpay-money/agent-signer";

export interface Stack {
  baseDomain: string;
  apiUrl: string;
  payUrl: string;
  /** Base of the payer-facing routes as the hosted checkout calls them. */
  payerApiUrl: string;
  dashboardUrl: string;
  merchantDemoUrl: string;
  /** Console host (`ops.<domain>`; its API is `<opsUrl>/api/ops/*`). */
  opsUrl: string;
  /** Mailpit (local stack). */
  mailUrl: string;
  deployDir: string;
  secretKey(): string | null;
  pinnedKeys(): PinnedSentinelKey[];
}

type Env = Record<string, string | undefined>;

export function stackFromEnv(env: Env = process.env, cwd: string = process.cwd()): Stack {
  const baseDomain = env.NP_BASE_DOMAIN ?? "nearpay.localhost";
  const port = env.NP_HTTPS_PORT && env.NP_HTTPS_PORT !== "443" ? `:${env.NP_HTTPS_PORT}` : "";
  const site = (name: string) => `https://${name}.${baseDomain}${port}`;
  const deployDir = resolve(cwd, env.NP_DEPLOY_DIR ?? "../nearpay-deploy");
  const readFile = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").trim() || null : null);
  return {
    baseDomain,
    apiUrl: env.NP_API_URL ?? site("api"),
    payUrl: env.NP_PAY_URL ?? site("pay"),
    payerApiUrl: env.NP_PAYER_API_URL ?? `${env.NP_PAY_URL ?? site("pay")}/api`,
    dashboardUrl: env.NP_DASHBOARD_URL ?? site("dashboard"),
    merchantDemoUrl: env.NP_MERCHANT_DEMO_URL ?? site("merchant-demo"),
    opsUrl: env.NP_OPS_URL ?? site("ops"),
    mailUrl: env.NP_MAIL_URL ?? site("mail"),
    deployDir,
    secretKey: () => env.NP_SECRET_KEY ?? readFile(join(deployDir, ".secrets/merchant-demo/secret_key")),
    pinnedKeys: () => {
      const file = env.NP_SENTINEL_KEYS_FILE ?? join(deployDir, ".secrets/public/sentinel_keys.json");
      const text = readFile(file);
      if (!text) throw new Error(`no pinned sentinel keys at ${file} (run nearpay-deploy/scripts/seed.sh keys)`);
      return parsePinnedKeys(text);
    },
  };
}
