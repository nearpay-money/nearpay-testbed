/**
 * T3 — checkout paid from a NEAR Intents balance by a human wallet (NEP-413): attested requirement →
 * signed_intent → agentpay relay → batcher → rails NEAR indexer binding match → payments success.
 * Precondition (test mode): the payer's sandbox Intents balance is funded (same as the demo agent).
 */
import { describe, expect, it } from "vitest";
import { agentSigner, USDC } from "../../demo/agent.js";
import { payFromIntentsBalance, sessionFromUrl } from "../../lib/payer.js";
import { enabled, md, payer, WEBHOOK_TIMEOUT_MS } from "../support/env.js";

describe.skipIf(!enabled)("T3 Intents-balance checkout", () => {
  it("signs the attested requirement and the intent succeeds", async () => {
    const demo = md();
    const s = await demo.checkout();
    const r = await payFromIntentsBalance(payer(s.url as string, sessionFromUrl), agentSigner(process.env, false), {
      originAssetId: USDC,
    });
    expect(r.attempt.method).toBe("intents_transfer");
    await demo.waitForEvent({ type: "payment_intent.succeeded", object: s.payment_intent }, WEBHOOK_TIMEOUT_MS);
  });
});
