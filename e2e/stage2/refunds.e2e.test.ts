/**
 * Stage 2 scenario 1 — refunds in test mode (lld/payments.md §8.4, dashboard §1 "Test-mode refunds"):
 *  a) a payment from Base (route_quote) refunded back to the payer's origin chain: the merchant creates the
 *     refund on the API the dashboard uses and takes the test-mode signing path (`simulateRefundDeposit`,
 *     "Simulate signed transfer") → refund `succeeded` with payer-side evidence, signed `refund.succeeded`
 *     webhook at merchant-demo, refund receipt to the customer in Mailpit;
 *  b) a payment from an Intents balance (intents_transfer) refunded to the payer's Intents account: the
 *     merchant signs the issued NEP-413 `sign_intent` verbatim (after the dashboard's consistency checks) →
 *     `submit_tx {signed_intent}` → agentpay relays it to the (sandbox) Verifier → refund `succeeded`.
 */
import { randomUUID } from "node:crypto";
import {
  createCheckoutSession,
  createRefund,
  getPaymentIntent,
  getRefund,
  type Refund,
  simulateRefundDeposit,
  submitRefundTx,
} from "@nearpay-money/spec";
import { beforeAll, describe, expect, it } from "vitest";
import { agentSigner, USDC } from "../../demo/agent.js";
import { payBySimulatedDeposit, payFromIntentsBalance, sessionFromUrl, TEST_REFUND_EVM } from "../../lib/payer.js";
import {
  checkSignIntent,
  DEMO_MERCHANT_ACCOUNT,
  DEMO_MERCHANT_SEED,
  type SignIntentAction,
  signNep413Intent,
} from "../../lib/refunds.js";
import { md, payer, realStack, WEBHOOK_TIMEOUT_MS } from "../support/env.js";
import { api, ensureWebhookEvents, mail, until } from "../support/stage2.js";

type Session = { id: string; url: string; payment_intent: string };
type Intent = { id: string; status: string; amount_settled: string | null };

async function paidSession(pay: (s: Session) => Promise<unknown>, customerEmail?: string): Promise<Intent> {
  const s = await api<Session>(createCheckoutSession, {
    body: {
      amount: 200,
      currency: "usd",
      success_url: "https://merchant-demo.nearpay.localhost/success",
      ...(customerEmail ? { customer_email: customerEmail } : {}),
    },
  });
  await pay(s);
  return until(
    () => api<Intent>(getPaymentIntent, { params: { id: s.payment_intent } }),
    (pi) => pi.status === "succeeded",
    WEBHOOK_TIMEOUT_MS,
    `${s.payment_intent} succeeded`,
  );
}

/** Creates the refund and waits for its prepared leg (`next_action`). */
/**
 * Route refund legs run the sandbox scenario of the refund amount's last two digits (sandbox §4), and the settled
 * amount carries a varying amount tag: refunding all of it picked scenario 04 (`failed_after_deposit`, held) in a step
 * 3.4 run. The largest amount ≤ the settled amount ending in `00` keeps the leg on scenario 00.
 */
const scenario00Amount = (settled: string) => {
  const a = BigInt(settled);
  return (a - (a % 100n)).toString();
};

async function preparedRefund(pi: Intent, reason?: string, amount?: string): Promise<Refund> {
  const created = await api<Refund>(createRefund, {
    body: { payment_intent: pi.id, ...(reason ? { reason } : {}), ...(amount ? { amount } : {}) },
  });
  expect(created.status).toBe("requires_action");
  return until(
    () => api<Refund>(getRefund, { params: { id: created.id } }),
    (r) => r.next_action !== null,
    30_000,
    `${created.id} next_action`,
  );
}

const final = (id: string) =>
  until(
    () => api<Refund>(getRefund, { params: { id } }),
    (r) => r.status === "succeeded" || r.status === "failed",
    3 * 60_000,
    `${id} final`,
  );

describe.skipIf(!realStack)("Stage 2 · refunds (test mode)", () => {
  beforeAll(async () => {
    // seed.sh data subscribes refund.* since step 2.4; older stacks get the events added here
    await ensureWebhookEvents(["refund.created", "refund.requires_action", "refund.succeeded", "refund.failed"]);
  });

  it("a) Base payment → refund to the payer's origin chain via the test-mode signing path", async () => {
    const customer = `refund-${randomUUID().slice(0, 8)}@payer.test`;
    const pi = await paidSession(
      (s) => payBySimulatedDeposit(payer(s.url, sessionFromUrl), { refundTo: TEST_REFUND_EVM }),
      customer,
    );
    const amount = scenario00Amount(pi.amount_settled as string);
    const re = await preparedRefund(pi, "requested_by_customer", amount);
    expect(re).toMatchObject({
      method: "route_quote",
      livemode: false,
      amount,
      recipient: { type: "origin_chain", chain: "eip155:8453", address: TEST_REFUND_EVM, overridden: false },
    });
    // the merchant's source is an Intents account: the live action would be a sign_intent from it
    expect(re.next_action?.type).toBe("sign_intent");
    const since = Date.now() - 2000;

    await api(simulateRefundDeposit, { params: { id: re.id }, body: {} });
    const done = await final(re.id);
    expect(done.status, JSON.stringify(done.legs)).toBe("succeeded");
    // INV-2: success carries the payer-side evidence of the leg on the payer's origin chain
    expect(done.evidence).toMatchObject({ chain: "eip155:8453", recipient: expect.stringMatching(/^0x/i) });
    expect(done.legs[0]).toMatchObject({ status: "succeeded", evidence: { chain: "eip155:8453" } });
    expect(BigInt(done.amount_received ?? "0")).toBeGreaterThan(0n);

    // signed webhook (merchant-demo verifies the v1 HMAC before recording it)
    const hook = await md().waitForEvent({ type: "refund.succeeded", object: re.id }, WEBHOOK_TIMEOUT_MS);
    expect(hook.event.data.object).toMatchObject({ id: re.id, status: "succeeded" });

    // refund receipt to the customer (notify → Mailpit)
    const receipt = await mail().latest(customer, /refund/i, 60_000, since);
    expect(receipt).toMatch(/refund/i);
    expect(receipt).toContain("Demo Shop");
  });

  it("b) Intents-balance payment → merchant-signed Intents refund relayed by agentpay", async () => {
    const signer = agentSigner(process.env, false);
    const pi = await paidSession((s) =>
      payFromIntentsBalance(payer(s.url, sessionFromUrl), signer, { originAssetId: USDC }),
    );
    const re = await preparedRefund(pi);
    expect(re).toMatchObject({
      method: "intents_transfer",
      recipient: { type: "intents", address: signer.signerId },
    });
    const action = re.next_action as unknown as SignIntentAction;
    expect(action).toMatchObject({ type: "sign_intent", signer_id: DEMO_MERCHANT_ACCOUNT });
    expect(action.transfer).toMatchObject({ receiver_id: signer.signerId, token: re.asset_id, amount: re.amount });
    checkSignIntent(action, re); // the dashboard's checks before any wallet prompt

    // a payload edited after issuance is refused (signed_intent_mismatch / intent_invalid), the leg stays open
    const tampered = {
      ...action,
      nep413: { ...action.nep413, message: action.nep413.message.replace(re.amount, "1") },
    };
    await expect(
      api(submitRefundTx, {
        params: { id: re.id },
        body: { signed_intent: signNep413Intent(tampered, DEMO_MERCHANT_SEED) },
      }),
    ).rejects.toMatchObject({ status: expect.any(Number) });
    expect((await api<Refund>(getRefund, { params: { id: re.id } })).next_action).not.toBeNull();

    const submitted = await api<Refund>(submitRefundTx, {
      params: { id: re.id },
      body: { signed_intent: signNep413Intent(action, DEMO_MERCHANT_SEED) },
    });
    expect(["pending", "requires_action", "succeeded"]).toContain(submitted.status);
    const done = await final(re.id);
    expect(done.status, JSON.stringify(done.legs)).toBe("succeeded");
    expect(done.legs[0]).toMatchObject({
      method: "intents_transfer",
      status: "succeeded",
      evidence: { chain: "near:mainnet", recipient: signer.signerId, amount: re.amount },
    });
    await md().waitForEvent({ type: "refund.succeeded", object: re.id }, WEBHOOK_TIMEOUT_MS);
  });
});
