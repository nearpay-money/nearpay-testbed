import { defineConfig } from "@playwright/test";

// Browser downloads are blocked here: use the system Chrome (brief; CI images ship Chrome too).
const chrome = {
  channel: "chrome" as const,
  launchOptions: { executablePath: process.env.NP_CHROME ?? "/usr/bin/google-chrome" },
};
const stack = process.env.NP_E2E === "1";

export default defineConfig({
  workers: 1,
  reporter: [["list"]],
  timeout: 60_000,
  projects: [
    // mock-backed (step 1.3): merchant-demo's page against the mock stack
    { name: "mock", testDir: "test/pw", testMatch: /.*\.pw\.ts/, use: { ...chrome, baseURL: "http://127.0.0.1:3917" } },
    // full stack (step 1.4): hosted checkout through merchant-demo, NP_E2E=1 (trusts the local CA via ignoreHTTPSErrors)
    ...(stack
      ? [
          {
            name: "stack",
            testDir: "e2e",
            testMatch: /.*\.pw\.ts/,
            use: {
              ...chrome,
              ignoreHTTPSErrors: true,
              baseURL: process.env.NP_MERCHANT_DEMO_URL ?? "https://merchant-demo.nearpay.localhost",
            },
          },
        ]
      : []),
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
