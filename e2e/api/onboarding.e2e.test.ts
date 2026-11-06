/**
 * T1 — merchant onboarding: dashboard passkey sign-up → magic link (Mailpit) → destination +
 * wallet attestation → cool-off → ops KYB decision → live. The whole flow runs in the browser in
 * e2e/dashboard/onboarding.pw.ts (`NP_E2E=1 pnpm test:pw`: virtual WebAuthn authenticator, real
 * NEP-413 signature); this suite covers the ops half through the Stage 1 ops CLI.
 */
import { describe, expect, it } from "vitest";
import { runCli } from "../../ops/cli.js";
import { ops, realStack, stack } from "../support/env.js";

const account = process.env.NP_E2E_KYB_ACCOUNT;

describe.skipIf(!realStack)("T1 onboarding", () => {
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
