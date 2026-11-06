/**
 * Sandbox scenarios 00–07 (lld/sandbox.md §4, api-conventions §8, domain-model §4–§5) as test-mode
 * checkout amounts in USD cents (scenario = last two digits). The expectations are what the E2E
 * suite asserts against the full stack (confirmed in step 1.4).
 *
 * Timing: the sandbox timeline runs on real time (`NP_SANDBOX_TIME_SCALE` 1.0 locally), and rails
 * caps a quote's deadline at the session's `expires_at` unless the merchant enables late payments
 * (payments §8.2, `deadline_cap`); the default deadline on Base is 30 min and its minimum 300 s (a
 * session with less time left gets `route_too_slow`). So 02 refunds 30 min after the quote (its
 * session must outlive the deadline to stay open), and 07 uses a 420 s session and settles 5 min
 * after that session's deadline.
 */
export interface Scenario {
  id: "00" | "01" | "02" | "03" | "04" | "05" | "06" | "07";
  title: string;
  amountCents: number;
  /** Final payment-intent status. */
  finalStatus: "succeeded" | "requires_payment" | "requires_review" | "expired";
  /** `review_reason` when the intent ends in `requires_review`. */
  reviewReason?: "short_settlement" | "verification_held";
  /** Final status of the (first) attempt, and its `failure_code` where one is expected. */
  attempt: { status: "succeeded" | "refunded" | "held"; failureCode?: string };
  /** Final checkout-session status (merchant view). */
  sessionStatus: "open" | "complete";
  /** Webhooks merchant-demo must receive (in any order). */
  webhooks: string[];
  /** Webhooks that must never arrive for this intent (checked once the final state is reached). */
  forbidden: string[];
  /** Session `expires_in` override (s). */
  expiresIn?: number;
  /** Slow scenarios (minutes of sandbox time) run only with NP_E2E_SLOW=1. */
  slow?: boolean;
  /** Upper bound for the whole scenario (ms). */
  timeoutMs: number;
  /** Extra checks, described for the suite. */
  note: string;
}

const MIN = 60_000;

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "00",
    title: "exact payment",
    amountCents: 200,
    finalStatus: "succeeded",
    attempt: { status: "succeeded" },
    sessionStatus: "complete",
    webhooks: ["payment_intent.succeeded", "checkout.session.completed"],
    forbidden: ["payment_intent.payment_failed", "payment_intent.requires_review"],
    timeoutMs: 2 * MIN,
    note: "INV-2: the winning attempt carries evidence; one payment statement line",
  },
  {
    id: "01",
    title: "slow chain (success after 120 s)",
    amountCents: 201,
    finalStatus: "succeeded",
    attempt: { status: "succeeded" },
    sessionStatus: "complete",
    webhooks: ["payment_intent.processing", "payment_intent.succeeded", "checkout.session.completed"],
    forbidden: ["payment_intent.payment_failed"],
    slow: true,
    timeoutMs: 6 * MIN,
    note: "processing first (PROCESSING at 3 s is observed), success after 120 s",
  },
  {
    id: "02",
    title: "underpaid → refunded at deadline",
    amountCents: 202,
    finalStatus: "requires_payment",
    attempt: { status: "refunded" },
    sessionStatus: "open",
    webhooks: ["payment_intent.payment_failed"],
    forbidden: ["payment_intent.succeeded", "checkout.session.completed"],
    slow: true,
    timeoutMs: 40 * MIN,
    note: "attempt incomplete_deposit → refunded at the 30 min quote deadline; the 1 h session stays open for a new attempt",
  },
  {
    id: "03",
    title: "overpaid → success + excess refund",
    amountCents: 203,
    finalStatus: "succeeded",
    attempt: { status: "succeeded" },
    sessionStatus: "complete",
    webhooks: ["payment_intent.succeeded", "checkout.session.completed"],
    forbidden: ["payment_intent.overpaid"],
    timeoutMs: 2 * MIN,
    note: "1Click EXACT_OUTPUT: the excess goes back to refund_to; the merchant gets the exact amount (no overpayment)",
  },
  {
    id: "04",
    title: "provider FAILED after deposit",
    amountCents: 204,
    finalStatus: "requires_review",
    reviewReason: "verification_held",
    attempt: { status: "held", failureCode: "failed_after_deposit" },
    sessionStatus: "open",
    webhooks: ["payment_intent.requires_review"],
    forbidden: ["payment_intent.succeeded", "payment_intent.payment_failed", "checkout.session.completed"],
    timeoutMs: 2 * MIN,
    note: "domain-model §4.3: FAILED after a deposit means funds are somewhere → attempt held (case), intent requires_review; never failed or succeeded on its own",
  },
  {
    id: "05",
    title: "SUCCESS but evidence short",
    amountCents: 205,
    finalStatus: "requires_review",
    reviewReason: "short_settlement",
    attempt: { status: "succeeded" },
    sessionStatus: "open",
    webhooks: ["payment_intent.requires_review"],
    forbidden: ["payment_intent.succeeded", "checkout.session.completed"],
    timeoutMs: 3 * MIN,
    note: "INV-2: no succeeded event; review_reason short_settlement",
  },
  {
    id: "06",
    title: "duplicate settlement on a second attempt",
    amountCents: 206,
    finalStatus: "succeeded",
    attempt: { status: "succeeded" },
    sessionStatus: "complete",
    webhooks: ["payment_intent.succeeded", "payment_intent.overpaid", "checkout.session.completed"],
    forbidden: ["payment_intent.payment_failed"],
    timeoutMs: 3 * MIN,
    note: "first settlement wins; the other attempt is in overpayments[] (reason duplicate) with its own statement line",
  },
  {
    id: "07",
    title: "late settlement after session expiry",
    amountCents: 207,
    finalStatus: "succeeded",
    attempt: { status: "succeeded" },
    sessionStatus: "complete",
    webhooks: ["payment_intent.succeeded", "checkout.session.completed"],
    forbidden: ["payment_intent.expired", "checkout.session.expired"],
    expiresIn: 420,
    slow: true,
    timeoutMs: 18 * MIN,
    note: "INV-3: the 420 s session is expiring, never expired, while the attempt is in flight; it completes with late = true",
  },
];

export function scenarioOf(amountCents: number): Scenario["id"] {
  return String(amountCents % 100).padStart(2, "0") as Scenario["id"];
}
