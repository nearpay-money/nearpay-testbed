import { createHash, X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineConfig } from "@playwright/test";

// Browser downloads are blocked here: use the system Chrome (brief; CI images ship Chrome too).
const chrome = {
  channel: "chrome" as const,
  launchOptions: { executablePath: process.env.NP_CHROME ?? "/usr/bin/google-chrome" },
};
const stack = process.env.NP_E2E === "1";

/**
 * Chrome refuses WebAuthn on pages with certificate errors, and `ignoreHTTPSErrors` only hides the
 * error. Pinning the local leaf's SPKI makes Chrome treat nearpay-deploy's certificate as valid, so
 * passkeys work without installing the local CA (a no-op where mkcert's CA is already trusted).
 */
function localCertArgs(): string[] {
  const cert = join(resolve(process.env.NP_DEPLOY_DIR ?? "../nearpay-deploy"), ".secrets/tls/cert.pem");
  if (!existsSync(cert)) return [];
  const spki = new X509Certificate(readFileSync(cert)).publicKey.export({ type: "spki", format: "der" });
  return [`--ignore-certificate-errors-spki-list=${createHash("sha256").update(spki).digest("base64")}`];
}

export default defineConfig({
  workers: 1,
  reporter: [["list"]],
  timeout: 60_000,
  // NP_E2E=1 runs the full-stack project only (the mock project needs the mock server below)
  projects: stack
    ? [
        // full stack (step 1.4): hosted checkout through merchant-demo (e2e/checkout) and the dashboard
        // onboarding (e2e/dashboard, T1)
        {
          name: "stack",
          testDir: "e2e",
          testMatch: /.*\.pw\.ts/,
          use: {
            ...chrome,
            launchOptions: { ...chrome.launchOptions, args: localCertArgs() },
            ignoreHTTPSErrors: true,
            baseURL: process.env.NP_MERCHANT_DEMO_URL ?? "https://merchant-demo.nearpay.localhost",
          },
        },
      ]
    : [
        // mock-backed (step 1.3): merchant-demo's page against the mock stack
        {
          name: "mock",
          testDir: "test/pw",
          testMatch: /.*\.pw\.ts/,
          use: { ...chrome, baseURL: "http://127.0.0.1:3917" },
        },
      ],
  webServer: stack
    ? undefined
    : {
        command: "pnpm exec tsx test/support/serve-mock.ts",
        url: "http://127.0.0.1:3917/healthz",
        reuseExistingServer: false,
        timeout: 30_000,
      },
});
