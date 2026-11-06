/**
 * T1 — merchant onboarding: dashboard passkey sign-up → magic link (Mailpit) → destination +
 * wallet attestation → cool-off → ops KYB decision → live. The browser steps are Playwright suites
 * once nearpay-dashboard's dist exists (e2e/dashboard/, virtual WebAuthn authenticator); this suite
 * covers the ops half through the Stage 1 ops CLI.
 */
import { describe, expect, it } from "vitest";
import { runCli } from "../../ops/cli.js";
import { ops, realStack, stack } from "../support/env.js";

const account = process.env.NP_E2E_KYB_ACCOUNT;

describe.skipIf(!realStack)("T1 onboarding", () => {
  it.todo("dashboard: passkey sign-up + magic link from Mailpit (e2e/dashboard, Playwright)");
  it.todo("dashboard: add a USDC NEAR Intents destination and sign the NEP-413 attestation");
  it.todo("dashboard: submit the KYB form (POST /v1/account/kyb)");

  it("the seeded demo merchant is visible to ops", () => {
    const r = ops("identity-api", ["account-show", "demo@merchant.test"]);
    expect(r.code).toBe(0);
    expect(JSON.stringify(r.json)).toContain("acct_");
  });

  it.skipIf(!account)("ops CLI approves KYB → account live", () => {
    expect(
      runCli(["kyb-decide", account as string, "approved", "--reason", "testbed e2e"], {
        deployDir: stack().deployDir,
        out: () => {},
      }),
    ).toBe(0);
    const show = ops("identity-api", ["account-show", account as string]);
    expect(JSON.stringify(show.json)).toMatch(/"kyb_status":\s*"approved"/);
  });
});
