/**
 * Stage 3 scenario 2 — subscription renewal (development plan §5 step 3.4 "a subscription renewal invoice is issued
 * and paid"; billing §13 test clock, spec 0.3.1 `advanceSubscriptionClock`): create on a monthly price → first
 * invoice issued at once (subscription `incomplete`) → paid → `active` → clock to `renewal_upcoming` (event + mail) →
 * clock to `renewal` (renewal invoice created, finalized, sent; mail) → paid from Solana → still `active`, period
 * moved → next renewal left unpaid → clock to `overdue` (`invoice.overdue`, `past_due`, overdue reminder mail) →
 * paid late → `active` again. Every step is checked on the merchant-demo webhooks (signature-verified).
 */
import { advanceSubscriptionClock, getSubscription, listInvoices } from "@nearpay/spec";
import { beforeAll, describe, expect, it } from "vitest";
import { md, realStack, WEBHOOK_TIMEOUT_MS } from "../support/env.js";
import { api, until } from "../support/stage2.js";
import {
  catalogue,
  customerMail,
  ensureStage3Webhooks,
  getInv,
  hostedLinkIn,
  type Invoice,
  invoiceUntil,
  payInvoice,
  type Subscription,
  subscribe,
  TEST_REFUND_SOLANA,
  USDC_SOLANA,
} from "../support/stage3.js";

const PAY_MS = 3 * 60_000;
const getSub = (id: string) => api<Subscription>(getSubscription, { params: { id } });
const subUntil = (id: string, done: (s: Subscription) => boolean, what: string) =>
  until(() => getSub(id), done, 90_000, `${id} ${what}`);
const advance = (id: string, target: "renewal_upcoming" | "renewal" | "overdue") =>
  api<{ target: string; clock_time: number; advanced_by: number }>(advanceSubscriptionClock, {
    params: { id },
    body: { target },
  });
const invoicesOf = (sub: string) =>
  api<{ data: Invoice[] }>(listInvoices, { query: { subscription: sub, limit: "20" } }).then((l) => l.data);
const webhook = (type: string, object: string, match?: (o: Record<string, unknown>) => boolean) =>
  md().waitForEvent(
    { type, object, ...(match ? { match: (e) => match(e.event.data.object) } : {}) },
    WEBHOOK_TIMEOUT_MS,
  );

describe.skipIf(!realStack)("Stage 3 · subscriptions", () => {
  let cat: Awaited<ReturnType<typeof catalogue>>;
  beforeAll(async () => {
    await ensureStage3Webhooks();
    cat = await catalogue("sub");
  });

  it("first invoice → active → renewal_upcoming → renewal invoice paid → overdue → dunning → paid late", async () => {
    const t0 = Date.now() - 2000;
    const sub = await subscribe(cat, "sub");
    expect(sub.status).toBe("incomplete");
    await webhook("customer.subscription.created", sub.id);
    const first = await getInv(sub.latest_invoice as string);
    expect(first).toMatchObject({ subscription: sub.id, status: "open", billing_reason: "subscription_create" });
    await webhook("invoice.sent", first.id);
    const firstMail = await customerMail(cat.email, new RegExp(`^Invoice ${first.number} from `), t0);
    await payInvoice(hostedLinkIn(firstMail, first.id));
    await invoiceUntil(first.id, (i) => i.status === "paid", PAY_MS, "paid");
    const active = await subUntil(sub.id, (s) => s.status === "active", "active");
    await webhook("customer.subscription.updated", sub.id, (o) => o.status === "active");

    // renewal notice: 3 days before the period end
    const t1 = Date.now() - 2000;
    const up = await advance(sub.id, "renewal_upcoming");
    expect(up).toMatchObject({ target: "renewal_upcoming" });
    expect(up.clock_time).toBeGreaterThanOrEqual(active.current_period_end - 3 * 86_400 - 60);
    await webhook("customer.subscription.renewal_upcoming", sub.id);
    await customerMail(cat.email, /subscription renews on .*\[test\]$/, t1);
    // the notice is sent once: moving to it again is a conflict
    await expect(advance(sub.id, "renewal_upcoming")).rejects.toMatchObject({ status: 409, code: "state_conflict" });

    // renewal: the next period's invoice is created, finalized and sent
    const t2 = Date.now() - 2000;
    await advance(sub.id, "renewal");
    const renewal = await until(
      () => invoicesOf(sub.id),
      (l) => l.some((i) => i.id !== first.id && i.billing_reason === "subscription_cycle" && i.status === "open"),
      90_000,
      "renewal invoice",
    ).then((l) => l.find((i) => i.id !== first.id && i.billing_reason === "subscription_cycle") as Invoice);
    for (const t of ["invoice.created", "invoice.finalized", "invoice.sent"]) await webhook(t, renewal.id);
    const renewalMail = await customerMail(cat.email, new RegExp(`^Invoice ${renewal.number} from `), t2);
    await payInvoice(hostedLinkIn(renewalMail, renewal.id), {
      originAssetId: USDC_SOLANA,
      refundTo: TEST_REFUND_SOLANA,
    });
    await invoiceUntil(renewal.id, (i) => i.status === "paid", PAY_MS, "renewal paid");
    await webhook("invoice.paid", renewal.id);
    const renewed = await subUntil(sub.id, (s) => s.current_period_start >= active.current_period_end, "next period");
    expect(renewed.status).toBe("active");

    // next renewal left unpaid until its due date: overdue → past_due, reminder mail (dunning)
    await advance(sub.id, "renewal");
    const unpaid = await until(
      () => invoicesOf(sub.id),
      (l) => l.some((i) => ![first.id, renewal.id].includes(i.id) && i.status === "open"),
      90_000,
      "second renewal invoice",
    ).then((l) => l.find((i) => ![first.id, renewal.id].includes(i.id)) as Invoice);
    const t3 = Date.now() - 2000;
    await advance(sub.id, "overdue");
    await webhook("invoice.overdue", unpaid.id);
    await subUntil(sub.id, (s) => s.status === "past_due", "past_due");
    await webhook("customer.subscription.updated", sub.id, (o) => o.status === "past_due");
    await customerMail(cat.email, new RegExp(`^Overdue: invoice ${unpaid.number} from `), t3);

    // paying the overdue invoice reactivates the subscription
    await payInvoice(unpaid.hosted_invoice_url as string);
    await invoiceUntil(unpaid.id, (i) => i.status === "paid", PAY_MS, "overdue invoice paid");
    await subUntil(sub.id, (s) => s.status === "active", "active again");
  });
});
