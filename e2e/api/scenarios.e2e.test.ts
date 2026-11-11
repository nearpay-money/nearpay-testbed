/**
 * Sandbox scenarios 00–07 (lld/sandbox.md §4) through the whole stack: amount suffix → sandbox
 * timeline → rails → payments → webhooks at merchant-demo. Expectations in lib/scenarios.ts
 * (domain-model §4–§5); the final state is read back through the merchant API (session with its
 * expanded intent, statement lines). 01, 02 and 07 take minutes of sandbox time: they need
 * NP_E2E_SLOW=1 and run concurrently with each other (02 alone waits for a 30 min quote deadline).
 */

import {
  type CheckoutSession,
  getCheckoutSession,
  listBalanceTransactions,
  type PaymentIntent,
  simulateDeposit,
  type z,
} from "@nearpay-money/spec";
import { describe, expect, it } from "vitest";
import { call } from "../../lib/http.js";
import { attestedAttempt, payBySimulatedDeposit, sessionFromUrl, TEST_REFUND_EVM, USDC_BASE } from "../../lib/payer.js";
import { SCENARIOS, type Scenario } from "../../lib/scenarios.js";
import { waitFor } from "../../lib/wait.js";
import { enabled, md, payer, realStack, slow, stack } from "../support/env.js";

type Session = z.output<typeof CheckoutSession> & { payment_intent: z.output<typeof PaymentIntent> };

const merchantSession = async (id: string): Promise<Session> =>
  call<Session>(getCheckoutSession, {
    base: stack().apiUrl,
    params: { id },
    query: { "expand[]": "payment_intent" },
    secretKey: stack().secretKey() ?? "",
  });

async function run(sc: Scenario): Promise<void> {
  const demo = md();
  const s = await demo.checkout(sc.amountCents, sc.expiresIn);
  const ctx = payer(s.url as string, sessionFromUrl);
  let first: string;
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
    first = a1.attempt.id;
  } else {
    first = (await payBySimulatedDeposit(ctx)).attempt.id;
  }

  const deadline = Date.now() + sc.timeoutMs;
  const left = () => Math.max(1000, deadline - Date.now());
  for (const type of sc.webhooks) {
    const object = type.startsWith("checkout.session") ? s.id : s.payment_intent;
    await demo.waitForEvent({ type, object }, left(), 2000);
  }
  const final = await waitFor(
    async () => {
      const m = await merchantSession(s.id);
      const a = m.payment_intent.attempts.find((x) => x.id === first);
      return m.payment_intent.status === sc.finalStatus && a?.status === sc.attempt.status ? m : undefined;
    },
    { timeoutMs: left(), intervalMs: 2000, what: `intent ${s.payment_intent} → ${sc.finalStatus}` },
  );
  const pi = final.payment_intent;
  const attempt = pi.attempts.find((x) => x.id === first);

  expect(final.status).toBe(sc.sessionStatus);
  expect(pi.review_reason).toBe(sc.reviewReason ?? null);
  if (sc.attempt.failureCode) expect(attempt?.failure_code).toBe(sc.attempt.failureCode);
  const received = (await demo.events({ object: s.payment_intent })).map((e) => e.type);
  for (const type of sc.forbidden.filter((t) => t.startsWith("payment_intent."))) expect(received).not.toContain(type);
  const sessionEvents = (await demo.events({ object: s.id })).map((e) => e.type);
  for (const type of sc.forbidden.filter((t) => t.startsWith("checkout.session."))) {
    expect(sessionEvents).not.toContain(type);
  }

  // INV-2: success only with verified evidence (and a short settlement is never success)
  if (sc.finalStatus === "succeeded") {
    const won = pi.attempts.filter((x) => x.status === "succeeded" && !x.is_overpayment);
    expect(won).toHaveLength(1);
    expect(won[0]?.evidence).toBeTruthy();
    expect(BigInt(pi.amount_settled)).toBe(BigInt(won[0]?.settled_amount ?? "-1"));
  } else {
    expect(pi.succeeded_at).toBeNull();
  }
  if (sc.id === "05") {
    // settled one base unit short of the attested amount
    expect(BigInt(attempt?.settled_amount ?? "0")).toBe(BigInt(attempt?.settlement_amount ?? "0") - 1n);
  }
  if (sc.id === "06") {
    expect(pi.overpayments).toHaveLength(1);
    expect(pi.overpayments[0]).toMatchObject({ reason: "duplicate" });
    expect(pi.overpayments[0]?.attempt).not.toBe(
      pi.attempts.find((x) => !x.is_overpayment && x.status === "succeeded")?.id,
    );
  }
  if (sc.id === "07") {
    expect(pi.late).toBe(true); // INV-3
    expect(final.expires_at).toBeLessThan(Math.floor(Date.now() / 1000));
  }

  if (realStack) {
    // statement (domain-model §6): one payment line per success, one overpayment line per duplicate
    const lines = await call<{ data: { type: string }[] }>(listBalanceTransactions, {
      base: stack().apiUrl,
      query: { payment_intent: s.payment_intent },
      secretKey: stack().secretKey() ?? "",
    });
    const types = lines.data.map((l) => l.type).sort();
    const expected =
      sc.id === "06" ? ["overpayment", "payment"] : sc.finalStatus === "succeeded" || sc.id === "05" ? ["payment"] : [];
    expect(types).toStrictEqual(expected);
  }
}

describe.skipIf(!enabled)("sandbox scenarios 00–07", () => {
  for (const sc of SCENARIOS.filter((x) => !x.slow)) {
    const on = sc.id === "00" || realStack;
    it.skipIf(!on)(`${sc.id} ${sc.title}`, () => run(sc), sc.timeoutMs + 60_000);
  }
  // minutes of sandbox time each: run side by side
  describe.concurrent("slow", () => {
    for (const sc of SCENARIOS.filter((x) => x.slow)) {
      it.skipIf(!(realStack && slow))(`${sc.id} ${sc.title}`, () => run(sc), sc.timeoutMs + 60_000);
    }
  });
});
