/**
 * T2 — cross-chain checkout (EVM payer, USDC on Base → merchant's Intents account) and T6 — test mode
 * end to end (lld/audits/system.md §3): merchant-demo creates the session, a scripted payer verifies
 * sentinel's co-signature and simulates the deposit, the sandbox timeline settles, rails evidence →
 * payments → webhooks → merchant-demo (signature verified there).
 */
import { describe, expect, it } from "vitest";
import { payBySimulatedDeposit, sessionFromUrl } from "../../lib/payer.js";
import { enabled, md, payer, realStack, WEBHOOK_TIMEOUT_MS } from "../support/env.js";

describe.skipIf(!enabled)("T2/T6 checkout in test mode", () => {
  it("USD 2.00 session → attested deposit instructions → simulated payment → signed webhooks", async () => {
    const demo = md();
    const s = await demo.checkout();
    expect(s).toMatchObject({ amount: 200, currency: "usd", livemode: false });
    const paid = await payBySimulatedDeposit(payer(s.url as string, sessionFromUrl));
    expect(paid.attempt.deposit?.chain).toBe("eip155:8453");
    expect(paid.fingerprint).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{2}$/);
    const succeeded = await demo.waitForEvent(
      { type: "payment_intent.succeeded", object: s.payment_intent },
      WEBHOOK_TIMEOUT_MS,
    );
    expect(succeeded.event.data.object.status).toBe("succeeded");
    await demo.waitForEvent({ type: "checkout.session.completed", object: s.id }, WEBHOOK_TIMEOUT_MS);
    const order = await demo.order(s.id);
    expect(order.status).toBe("complete");
    expect(BigInt(order.payment_intent.amount_settled ?? "0")).toBeGreaterThan(0n);
  });

  it.skipIf(!realStack)("INV-2: the succeeded attempt carries verified evidence", async () => {
    const demo = md();
    const s = await demo.checkout();
    await payBySimulatedDeposit(payer(s.url as string, sessionFromUrl));
    await demo.waitForEvent({ type: "payment_intent.succeeded", object: s.payment_intent }, WEBHOOK_TIMEOUT_MS);
    const order = (await demo.order(s.id)) as unknown as {
      payment_intent: { attempts: { status: string; evidence: unknown }[] };
    };
    const won = order.payment_intent.attempts.find((a) => a.status === "succeeded");
    expect(won?.evidence).toBeTruthy();
  });
});
