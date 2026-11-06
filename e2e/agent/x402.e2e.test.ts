/**
 * T4 — an agent pays an x402 API (merchant-demo `/premium`): 402 → withX402 + agent-signer →
 * verify/settle → 200 + PAYMENT-RESPONSE → `agent_payment.settled` webhook (demo script step 5).
 * Precondition (test mode): the agent's sandbox Intents balance is funded (see README "Agent funding").
 */
import { decodePaymentResponse } from "@nearpay/x402";
import { describe, expect, it } from "vitest";
import { runAgentDemo } from "../../demo/agent.js";
import { enabled, md } from "../support/env.js";

describe.skipIf(!enabled)("T4 x402 agent payment", () => {
  it("pays /premium, gets the resource in ~2 s, and the payment cannot be replayed", async () => {
    const r = await runAgentDemo(["--timeout", "60"], { log: () => {} });
    expect(r.transaction).not.toBe("");
    expect(r.eventId).toMatch(/^evt_/);
    expect(r.elapsedMs).toBeLessThan(10_000); // demo target ~2 s; settle waits ≤ 8 s
    const replay = await fetch(md().premiumUrl, { headers: { "PAYMENT-SIGNATURE": r.header } });
    expect(replay.status).toBe(402);
    expect(decodePaymentResponse(replay)?.success).toBe(false);
  });
});
