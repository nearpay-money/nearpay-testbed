/**
 * Sandbox scenarios 00–07 (lld/sandbox.md §4) through the whole stack: amount suffix → sandbox
 * timeline → rails → payments → webhooks at merchant-demo. Expectations in lib/scenarios.ts
 * (domain-model §5 outcome matrix); 01, 02 and 07 need NP_E2E_SLOW=1.
 */

import { simulateDeposit } from "@nearpay/spec";
import { describe, expect, it } from "vitest";
import { call } from "../../lib/http.js";
import { attestedAttempt, payBySimulatedDeposit, sessionFromUrl, TEST_REFUND_EVM, USDC_BASE } from "../../lib/payer.js";
import { SCENARIOS } from "../../lib/scenarios.js";
import { waitFor } from "../../lib/wait.js";
import { enabled, md, payer, realStack, slow, WEBHOOK_TIMEOUT_MS } from "../support/env.js";

describe.skipIf(!enabled)("sandbox scenarios 00–07", () => {
  for (const sc of SCENARIOS) {
    const run = sc.id === "00" || (realStack && (!sc.slow || slow));
    it.skipIf(!run)(`${sc.id} ${sc.title}`, async () => {
      const demo = md();
      // 07: a short session so the late settlement lands after expires_at (INV-3)
      const s = await demo.checkout(sc.amountCents, sc.id === "07" ? 300 : undefined);
      const ctx = payer(s.url as string, sessionFromUrl);
      if (sc.id === "06") {
        // two attempts both deposit: the first settlement wins, the second is an overpayment
        const a1 = await attestedAttempt(ctx, {
          method: "route_quote",
          originAssetId: USDC_BASE,
          refundTo: TEST_REFUND_EVM,
        });
        const a2 = await attestedAttempt(ctx, {
          method: "route_quote",
          originAssetId: USDC_BASE,
          refundTo: TEST_REFUND_EVM,
        });
        for (const a of [a1, a2]) {
          await call(simulateDeposit, {
            base: ctx.apiBase,
            params: { id: ctx.sessionId, attempt: a.attempt.id },
            clientSecret: ctx.clientSecret,
            body: {},
          });
        }
      } else {
        await payBySimulatedDeposit(ctx);
      }
      const timeout = sc.slow ? 15 * 60_000 : WEBHOOK_TIMEOUT_MS;
      for (const type of sc.webhooks) {
        const object = type.startsWith("checkout.session") ? s.id : s.payment_intent;
        await demo.waitForEvent({ type, object }, timeout);
      }
      const order = await waitFor(
        async () => {
          const o = await demo.order(s.id);
          return o.payment_intent.status === sc.finalStatus ? o : undefined;
        },
        { timeoutMs: timeout, intervalMs: 2000, what: `intent ${s.payment_intent} → ${sc.finalStatus}` },
      );
      if (sc.id === "05") expect(order.events).not.toContain("payment_intent.succeeded"); // INV-2
      if (sc.id === "07") expect(order.payment_intent.late).toBe(true); // INV-3
    });
  }
});
