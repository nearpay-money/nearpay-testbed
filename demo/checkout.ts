/**
 * `pnpm demo:checkout` — Stage 1 demo script steps 2–4 (roadmap/development-plan.md §3):
 *
 *   2. merchant-demo creates a USD 2.00 checkout session (POST /checkout → POST /v1/checkout/sessions)
 *   3. the payer pays: live — open the printed URL and pay with an EVM wallet (USDC on Base);
 *      test mode — a scripted payer creates an attempt, verifies sentinel's co-signature with the
 *      pinned key, and presses "Simulate payment" (payments test helper → sandbox)
 *   4. waits for `payment_intent.succeeded` at merchant-demo (signature verified there) and prints
 *      the settled amount
 *
 * Options: --amount <cents> (test mode; sandbox scenario = last two digits), --no-pay (only create
 * and wait), --timeout <s> (default 120 test / 900 live). Stack locations: lib/stack.ts.
 */
import { parseArgs } from "node:util";
import { merchantDemo } from "../lib/merchant-demo.js";
import { payBySimulatedDeposit, sessionFromUrl } from "../lib/payer.js";
import { type Stack, stackFromEnv } from "../lib/stack.js";

export interface CheckoutDemoResult {
  sessionId: string;
  url: string | null;
  livemode: boolean;
  paymentIntent: string;
  eventId: string;
  amountSettled: string | undefined;
}

export async function runCheckoutDemo(
  argv: readonly string[],
  deps: { stack?: Stack; log?: (s: string) => void; fetch?: typeof fetch } = {},
): Promise<CheckoutDemoResult> {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    options: { amount: { type: "string" }, "no-pay": { type: "boolean" }, timeout: { type: "string" } },
  });
  const log = deps.log ?? ((s: string) => process.stdout.write(`${s}\n`));
  const stack = deps.stack ?? stackFromEnv();
  const md = merchantDemo(stack.merchantDemoUrl, deps.fetch);
  const t0 = Date.now();

  log(`[2] merchant-demo creates a checkout session (${stack.merchantDemoUrl}/checkout)`);
  const session = await md.checkout(values.amount ? Number(values.amount) : undefined);
  log(
    `    ${session.id}  ${session.currency.toUpperCase()} ${(session.amount / 100).toFixed(2)}  ${session.livemode ? "LIVE" : "test mode"}`,
  );
  log(`    checkout: ${session.url}`);

  if (!values["no-pay"]) {
    if (session.livemode) {
      log(
        "[3] open the checkout URL, connect an EVM wallet holding USDC on Base, check the merchant name and fingerprint, pay",
      );
    } else {
      if (!session.url) throw new Error("the session has no URL");
      const { sessionId, clientSecret } = sessionFromUrl(session.url);
      log("[3] scripted payer: attempt → sentinel co-signature (pinned key) → Simulate payment");
      const paid = await payBySimulatedDeposit({
        apiBase: stack.payerApiUrl,
        sessionId,
        clientSecret,
        pinnedKeys: stack.pinnedKeys(),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
      log(
        `    attested merchant: ${paid.merchant.name}${paid.merchant.kyb_verified ? " (business details declared)" : ""}  destination ${paid.fingerprint}`,
      );
      log(
        `    deposit ${paid.attempt.deposit?.amount_in} → ${paid.attempt.deposit?.address} on ${paid.attempt.deposit?.chain} (simulated)`,
      );
    }
  }

  const timeoutMs = Number(values.timeout ?? (session.livemode ? 900 : 120)) * 1000;
  log(`[4] waiting for payment_intent.succeeded at merchant-demo (≤ ${timeoutMs / 1000} s)`);
  const event = await md.waitForEvent({ type: "payment_intent.succeeded", object: session.payment_intent }, timeoutMs);
  const order = await md.order(session.id);
  log(`    ${event.id} received with a valid signature after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  log(
    `    intent ${order.payment_intent.id}: ${order.payment_intent.status}, settled ${order.payment_intent.amount_settled} base units; session ${order.status}`,
  );
  return {
    sessionId: session.id,
    url: session.url,
    livemode: session.livemode,
    paymentIntent: session.payment_intent,
    eventId: event.id,
    amountSettled: order.payment_intent.amount_settled,
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runCheckoutDemo(process.argv.slice(2)).then(
    () => process.exit(0),
    (e: Error) => {
      process.stderr.write(`demo:checkout failed: ${e.message}\n`);
      process.exit(1);
    },
  );
}
