import "./lib/localhost-dns.js"; // *.localhost → loopback for Node-side requests (Mailpit, APIs) in Playwright
import { defineConfig } from "@playwright/test";
import { chromeExecutable, localCertArgs } from "./lib/chrome.js";

// Browser downloads are blocked here: use the system Chrome (brief; CI images ship Chrome too).
const chrome = {
  channel: "chrome" as const,
  launchOptions: { executablePath: chromeExecutable() },
};
const stack = process.env.NP_E2E === "1";

// Chrome refuses WebAuthn on certificate errors: lib/chrome.ts pins the local leaf's SPKI.
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
