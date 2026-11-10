/**
 * Stage 2 scenario 4 — console smoke (lld/dashboard-and-console.md §2, identity §8.1, sentinel two-person
 * release, compliance KYB): everything through `ops.<domain>/api/ops/*` as the console calls it (ops cookie,
 * CSRF, step-up on 401), with operators enrolled by email link and software passkeys.
 *  a) two-person kill-switch release: `ops` engages; an `ops_admin` requests the release; the requester cannot
 *     approve (403 approver_conflict), an `ops` cannot approve (403 permission_denied, kit `ops_role`), a second
 *     `ops_admin` approves → released, both recorded as actors;
 *  b) a new merchant (dashboard passkey sign-up) adds a live destination (NEP-413), submits self-declared KYB
 *     (live at once with NP_KYB_MODE=auto, ADR-0024; console approval only with NP_KYB_MODE=manual);
 *     the account goes live; an operator rejects it for abuse (live off) and reverses it (live again).
 * Also: the console host serves the console and its anonymous sign-in allow-list only.
 */
import { randomUUID } from "node:crypto";
import {
  attestSettlementDestination,
  createSettlementDestination,
  getAccount,
  getKyb,
  startKyb,
  submitKyb,
  updateKybProfile,
} from "@nearpay/spec";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { base58Encode, signNep413, USDC_NEAR } from "../../lib/onboard.js";
import { DashboardSession, opsRoute } from "../../lib/ops-console.js";
import { TURNSTILE_TEST_TOKEN } from "../../lib/payer.js";
import { ops, realStack, stack } from "../support/env.js";
import { mail, operator, until } from "../support/stage2.js";

type KillSwitch = { engaged: boolean; actor: string; pending_release: { id: string } | null };

describe.skipIf(!realStack)("Stage 2 · console smoke", () => {
  it("serves the console; API routes need an ops session", async () => {
    const st = stack();
    const page = await fetch(`${st.opsUrl}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toMatch(/<div id="(root|app)"/);
    expect((await fetch(`${st.opsUrl}/api/ops/kill_switch`)).status).toBe(401);
    expect((await fetch(`${st.opsUrl}/api/ops/merchants`)).status).toBe(401);
  });

  it("a) two-person kill-switch release", async () => {
    const [engager, requester, approver] = await Promise.all([
      operator("ops", "ks"),
      operator("ops_admin", "ks"),
      operator("ops_admin", "ks"),
    ]);
    const engaged = await engager.call<KillSwitch>(opsRoute("engageOpsKillSwitch"), {
      body: { reason: "testbed E2E drill (step 2.4)" },
    });
    expect(engaged.engaged).toBe(true);
    try {
      const req = await requester.call<{ id: string }>(opsRoute("requestOpsKillSwitchRelease"), {
        body: { reason: "drill over" },
      });
      const approve = opsRoute("approveOpsKillSwitchRelease");
      await expect(requester.call(approve, { params: { id: req.id }, body: {} })).rejects.toMatchObject({
        status: 403,
        code: "approver_conflict",
      });
      await expect(engager.call(approve, { params: { id: req.id }, body: {} })).rejects.toMatchObject({
        status: 403,
        code: "permission_denied",
      });
      const released = await approver.call<KillSwitch>(approve, { params: { id: req.id }, body: { note: "checked" } });
      expect(released).toMatchObject({ engaged: false, pending_release: null });
      expect(released.actor.split("+")).toHaveLength(2);
    } finally {
      // never leave a stack engaged: fall back to the local CLI drill release
      const now = await engager.call<KillSwitch>(opsRoute("getOpsKillSwitch"));
      if (now.engaged) ops("sentinel-api", ["kill-switch-release", "testbed: E2E cleanup"]);
    }
    expect((await engager.call<KillSwitch>(opsRoute("getOpsKillSwitch"))).engaged).toBe(false);
  });

  it("b) self-declared KYB submit → live at once (auto) or console approval (manual) → abuse reject/reverse", async () => {
    const st = stack();
    const email = `kyb-${randomUUID().slice(0, 8)}@merchant.test`;
    const merchant = await DashboardSession.signUp(st.dashboardUrl, {
      email,
      displayName: "Console Smoke Shop",
      mail: mail(),
      turnstileToken: TURNSTILE_TEST_TOKEN,
    });
    const account = await merchant.call<{ id: string; live_enabled: boolean; kyb_status: string }>(getAccount);
    expect(account).toMatchObject({ live_enabled: false, kyb_status: "not_started" });

    // live destination: an implicit NEAR Intents account proves control with NEP-413, then the cool-off skip
    const seed = ed25519.utils.randomSecretKey();
    const pub = ed25519.getPublicKey(seed);
    const key = { accountId: Buffer.from(pub).toString("hex"), publicKey: `ed25519:${base58Encode(pub)}`, seed };
    merchant.mode = "live";
    const d = await merchant.call<{
      id: string;
      attestation_challenge: { id: string; message: string; recipient: string; nonce: string };
    }>(createSettlementDestination, {
      body: {
        asset_id: USDC_NEAR,
        type: "intents_account",
        chain: "near:mainnet",
        address: key.accountId,
        label: "Live (E2E)",
      },
    });
    const ch = d.attestation_challenge;
    await merchant.call(attestSettlementDestination, {
      params: { id: d.id },
      body: { challenge_id: ch.id, standard: "nep413", ...signNep413(key, ch) },
    });
    const skip = ops("identity-api", ["destination-cooloff-skip", d.id, "--actor", "testbed:e2e"]);
    expect(skip.code, skip.stderr).toBe(0);
    merchant.mode = undefined;

    // self-declared business details (ADR-0020 d3), submitted with the owner's declaration; no
    // registration number (optional since ADR-0024)
    await merchant.call(startKyb, { body: {} });
    await merchant.call(updateKybProfile, {
      body: {
        legal_name: "Console Smoke Shop GmbH",
        country_of_incorporation: "DE",
        business_type: "company",
        website: "https://smoke.example",
        business_address: { line1: "Teststr. 1", city: "Berlin", postal_code: "10115", country: "DE" },
        representative: { name: "Erika Mustermann", title: "Managing director" },
        expected_monthly_volume: "under_10k",
      },
    });
    const manual = process.env.NP_KYB_MODE === "manual";
    const submitted = await merchant.call<{ status: string }>(submitKyb, { body: { declaration: true } });
    // open onboarding (NP_KYB_MODE=auto, ADR-0024): decided by the system in the same request
    expect(submitted.status).toBe(manual ? "pending" : "approved");

    const op = await operator("ops", "kyb");
    const cases = await until(
      () =>
        op.call<{ data: { account_id: string; status: string; decided_by: string | null }[] }>(
          opsRoute("listOpsKybCases"),
          { query: { account: account.id, status: manual ? "pending" : "approved" } },
        ),
      (l) => l.data.some((c) => c.account_id === account.id),
      30_000,
      "business in the console list",
    );
    expect(cases.data[0]?.account_id).toBe(account.id);
    if (manual) {
      // decideOpsKybCase needs a step-up: the client answers 401 step_up_required with the passkey and replays
      const decided = await op.call<{ status: string }>(opsRoute("decideOpsKybCase"), {
        params: { id: account.id },
        body: { decision: "approved", reason: "testbed E2E (manual review mode)" },
      });
      expect(decided.status).toBe("approved");
    } else {
      expect(cases.data[0]?.decided_by).toBe("system");
    }

    const live = await until(
      () => merchant.call<{ live_enabled: boolean; kyb_status: string }>(getAccount),
      (a) => a.live_enabled,
      60_000,
      `${account.id} live_enabled`,
    );
    expect(live.kyb_status).toBe("approved");
    expect((await merchant.call<{ status: string }>(getKyb)).status).toBe("approved");

    // abuse: an operator rejects the business → live mode off; reversing it turns live mode back on
    const rejected = await op.call<{ status: string }>(opsRoute("decideOpsKybCase"), {
      params: { id: account.id },
      body: { decision: "rejected", reason: "testbed E2E: abuse report" },
    });
    expect(rejected.status).toBe("rejected");
    await until(
      () => merchant.call<{ live_enabled: boolean }>(getAccount),
      (a) => !a.live_enabled,
      60_000,
      `${account.id} live mode off after the rejection`,
    );
    await op.call(opsRoute("decideOpsKybCase"), {
      params: { id: account.id },
      body: { decision: "approved", reason: "testbed E2E: report withdrawn" },
    });
    await until(
      () => merchant.call<{ live_enabled: boolean }>(getAccount),
      (a) => a.live_enabled,
      60_000,
      `${account.id} live again after the reversal`,
    );
  });
});
