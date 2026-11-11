/**
 * T5 — an agent pays a checkout session: agent_pay/requirements → sentinel co-signature verified by
 * @nearpay-money/agent-signer with the pinned key (audit S-05) → agent_pay → relay → indexer → success.
 * Precondition (test mode): the agent's sandbox Intents balance is funded.
 */
import { payCheckoutSession, staticSaltProvider } from "@nearpay-money/agent-signer";
import { describe, expect, it } from "vitest";
import { agentSigner, USDC } from "../../demo/agent.js";
import { enabled, md, stack, WEBHOOK_TIMEOUT_MS } from "../support/env.js";

describe.skipIf(!enabled)("T5 agent pays a checkout session", () => {
  it("verifies sentinel before signing and the session completes", async () => {
    const demo = md();
    const s = await demo.checkout();
    const r = await payCheckoutSession(
      { url: s.url as string, apiBase: stack().payerApiUrl },
      agentSigner(process.env, false),
      {
        pinnedKeys: stack().pinnedKeys(),
        maxAmount: { [USDC]: "2100000" },
        livemode: false,
        nonceSaltProvider: staticSaltProvider("00000000"),
      },
    );
    expect(r.submission.status).toBe("submitted");
    expect(r.prepared.requirement.amount).not.toBe("0");
    await demo.waitForEvent({ type: "payment_intent.succeeded", object: s.payment_intent }, WEBHOOK_TIMEOUT_MS);
  });
});
