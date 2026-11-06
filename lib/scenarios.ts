/**
 * Sandbox scenarios 00–07 (lld/sandbox.md §4, api-conventions §8, domain-model §5) as test-mode
 * checkout amounts in USD cents (scenario = last two digits). The expectations are what the E2E
 * suite asserts in step 1.4.
 */
export interface Scenario {
  id: "00" | "01" | "02" | "03" | "04" | "05" | "06" | "07";
  title: string;
  amountCents: number;
  /** Final payment-intent status. */
  finalStatus: "succeeded" | "requires_payment" | "requires_review" | "expired";
  /** Webhooks merchant-demo must receive (in any order). */
  webhooks: string[];
  /** Slow scenarios (minutes of sandbox time) run only with NP_E2E_SLOW=1. */
  slow?: boolean;
  /** Extra checks, described for the suite. */
  note: string;
}

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "00",
    title: "exact payment",
    amountCents: 200,
    finalStatus: "succeeded",
    webhooks: ["payment_intent.succeeded", "checkout.session.completed"],
    note: "amount_settled equals the attested amount; one statement line",
  },
  {
    id: "01",
    title: "slow chain (success after 120 s)",
    amountCents: 201,
    finalStatus: "succeeded",
    webhooks: ["payment_intent.processing", "payment_intent.succeeded"],
    slow: true,
    note: "processing first, success later",
  },
  {
    id: "02",
    title: "underpaid → refunded at deadline",
    amountCents: 202,
    finalStatus: "requires_payment",
    webhooks: ["payment_intent.payment_failed"],
    slow: true,
    note: "attempt incomplete_deposit → refunded; session stays open for a new attempt",
  },
  {
    id: "03",
    title: "overpaid → success + excess refund",
    amountCents: 203,
    finalStatus: "succeeded",
    webhooks: ["payment_intent.succeeded"],
    note: "attempt refunded_amount = excess; merchant gets the exact amount",
  },
  {
    id: "04",
    title: "provider FAILED after deposit",
    amountCents: 204,
    finalStatus: "requires_payment",
    webhooks: ["payment_intent.payment_failed"],
    note: "attempt held → resolved refunded; no success event",
  },
  {
    id: "05",
    title: "SUCCESS but evidence short",
    amountCents: 205,
    finalStatus: "requires_review",
    webhooks: ["payment_intent.requires_review"],
    note: "INV-2: no succeeded event; review_reason short_settlement",
  },
  {
    id: "06",
    title: "duplicate settlement on a second attempt",
    amountCents: 206,
    finalStatus: "succeeded",
    webhooks: ["payment_intent.succeeded", "payment_intent.overpaid"],
    note: "first wins; second in overpayments[] (reason duplicate)",
  },
  {
    id: "07",
    title: "late settlement after session expiry",
    amountCents: 207,
    finalStatus: "succeeded",
    webhooks: ["payment_intent.succeeded", "checkout.session.completed"],
    slow: true,
    note: "INV-3: session complete with late = true (needs expires_in ≥ 300 s + 5 min)",
  },
];

export function scenarioOf(amountCents: number): Scenario["id"] {
  return String(amountCents % 100).padStart(2, "0") as Scenario["id"];
}
