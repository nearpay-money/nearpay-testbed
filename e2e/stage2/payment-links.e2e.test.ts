/**
 * Stage 2 scenario 2 — payment link paid from another chain than settlement (lld/payments.md §6.2, §19.1;
 * checkout `/l/:id`): the merchant creates a link; the payer opens it anonymously (`getPublicPaymentLink`,
 * hosted page `pay.<domain>/l/<id>` with `frame-ancestors 'none'`), starts a session (anonymous, Turnstile
 * test token) and pays from Base USDC while the merchant settles USDC on NEAR → session complete, link
 * `uses` + 1, signed `payment_intent.succeeded` webhook.
 */

import { randomUUID } from "node:crypto";
import {
  createPaymentLink,
  createPaymentLinkSession,
  getCheckoutSession,
  getPaymentLink,
  getPublicPaymentLink,
  HEADERS,
} from "@nearpay-money/spec";
import { describe, expect, it } from "vitest";
import { call } from "../../lib/http.js";
import { payBySimulatedDeposit, TURNSTILE_TEST_TOKEN, USDC_BASE } from "../../lib/payer.js";
import { md, payer, realStack, stack, WEBHOOK_TIMEOUT_MS } from "../support/env.js";
import { api, until } from "../support/stage2.js";

type Link = { id: string; url: string; uses: number; active: boolean };

describe.skipIf(!realStack)("Stage 2 · payment links", () => {
  it("cross-chain payment of a link: session completes, uses + 1, payment_intent.succeeded", async () => {
    const st = stack();
    const link = await api<Link>(createPaymentLink, {
      body: { amount: 300, currency: "usd", description: "E2E link", success_url: `${st.merchantDemoUrl}/success` },
    });
    expect(link).toMatchObject({ active: true, uses: 0 });
    expect(link.url).toBe(`${st.payUrl}/l/${link.id}`);

    // hosted page: never framed (deploy: pay /l/* with the hosted CSP header)
    const page = await fetch(link.url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");

    // anonymous reads and session creation, same-origin as the hosted checkout calls them
    const pub = await call<{ settlement: { asset_id: string }; amount: number }>(getPublicPaymentLink, {
      base: st.payerApiUrl,
      params: { id: link.id },
    });
    expect(pub.amount).toBe(300);
    const settlementAsset = pub.settlement.asset_id;
    expect(settlementAsset).not.toBe(USDC_BASE);
    const started = await call<{ checkout_session: string; client_secret: string; url: string }>(
      createPaymentLinkSession,
      {
        base: st.payerApiUrl,
        params: { id: link.id },
        body: {},
        idempotencyKey: randomUUID(),
        headers: { [HEADERS.turnstile]: TURNSTILE_TEST_TOKEN },
      },
    );

    const paid = await payBySimulatedDeposit(
      payer(started.url, () => ({ sessionId: started.checkout_session, clientSecret: started.client_secret })),
      { originAssetId: USDC_BASE },
    );
    expect(paid.attempt.deposit?.chain).toBe("eip155:8453");

    const session = await until(
      () =>
        api<{ status: string; payment_intent: string }>(getCheckoutSession, {
          params: { id: started.checkout_session },
        }),
      (s) => s.status === "complete",
      WEBHOOK_TIMEOUT_MS,
      `${started.checkout_session} complete`,
    );
    const hook = await md().waitForEvent(
      { type: "payment_intent.succeeded", object: session.payment_intent },
      WEBHOOK_TIMEOUT_MS,
    );
    expect(hook.event.data.object).toMatchObject({ status: "succeeded", settlement_asset_id: settlementAsset });
    await until(
      () => api<Link>(getPaymentLink, { params: { id: link.id } }),
      (l) => l.uses === 1,
      30_000,
      `${link.id} uses = 1`,
    );
  });
});
