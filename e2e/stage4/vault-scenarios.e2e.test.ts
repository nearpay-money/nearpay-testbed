/**
 * Stage 4 scenario 2 — the vault stand-in's failure scenarios through billing's keeper (lld/sandbox.md §4.2, chosen
 * by the last two digits of `amount_per_period`; lld/billing.md §7.1 keeper outcomes, §15 d8–d10). Asset-priced
 * subscriptions (USDC on NEAR, 1:1) so the amount picks the scenario; 3 periods funded unless noted.
 *
 * - `91` every merchant leg fails → `collect_failed`: period not counted, balance unchanged, `collect_failures`
 *   counts up (`mandate.updated`), the invoice stays unpaid; slow (NP_E2E_SLOW=1): after 5 failures the invoice
 *   falls back to `send_invoice` and is emailed, without `mandate.insufficient_funds`.
 * - `92` every fee leg fails → `collected` with `fee: "0"`: the invoice is paid (evidence `fee: "0"`), the fee stays
 *   in the mandate's balance.
 * - `93` the first refund fails → payer cancel ends `canceled {refunded: "0"}` with the balance kept → `withdraw`
 *   succeeds (`withdrawn`) and empties it.
 * - `94` partial delivery into the merchant's Intents account → `collected` with a short `merchant_share`
 *   (`floor(share / 2)`), `fee: "0"`: the invoice is not paid but voided with the collection recorded, and a
 *   `send_invoice` balance invoice for the shortfall is sent.
 */
import { listInvoices, prepareMandate } from "@nearpay/spec";
import { beforeAll, describe, expect, it } from "vitest";
import { md as demo, realStack, slow } from "../support/env.js";
import { api, until } from "../support/stage2.js";
import { customerMail, getInv, invoiceUntil, USDC_NEAR } from "../support/stage3.js";
import {
  type AutoDebitInvoice,
  autoDebitSubscription,
  ensureStage4Webhooks,
  expectedShare,
  fundMandate,
  getMd,
  intentsBalance,
  type Mandate,
  mandateFor,
  mandateUntil,
  payerAction,
  vaultEvents,
  webhook,
} from "../support/stage4.js";

const COLLECT_MS = 3 * 60_000;
const invoicesOf = (sub: string) =>
  api<{ data: AutoDebitInvoice[] }>(listInvoices, { query: { subscription: sub, limit: "20" } }).then((l) => l.data);

/** Asset-priced `auto_debit` subscription for `amount`, funded with `periods` periods; returns the linked mandate. */
async function funded(tag: string, amount: string, periods = 3) {
  const s = await autoDebitSubscription(tag, { assetAmount: amount });
  // the keeper collects period 1 within about a second of the funding, so the receiver's balance is read before it
  const { merchant_receiver } = await api<{ merchant_receiver: string }>(prepareMandate, {
    body: { subscription: s.sub.id, periods },
  });
  const receiverBefore = intentsBalance(merchant_receiver);
  const f = await fundMandate(s.sub.id, periods);
  expect(f).toMatchObject({ accepted: true });
  const md = await mandateFor(s.sub.id);
  expect(md).toMatchObject({ link_status: "linked", amount_per_period: amount, asset_id: USDC_NEAR });
  await webhook("mandate.activated", md.id);
  return { ...s, md, receiverBefore, first: s.sub.latest_invoice as string, total: BigInt(amount) * BigInt(periods) };
}

describe.skipIf(!realStack)("Stage 4 · vault stand-in scenarios 91–94", () => {
  beforeAll(async () => {
    await ensureStage4Webhooks();
  });

  it("91 merchant leg fails → collect_failed, not counted, invoice unpaid (slow: fallback after 5)", async () => {
    const amount = "10000091";
    const created = Date.now() - 2000; // the first invoice is emailed when the subscription is created
    const { md, first, total, email } = await funded("vault-91", amount);
    const failed = await mandateUntil(md.id, (m) => m.collect_failures >= 1, "collect_failed", COLLECT_MS);
    expect(failed).toMatchObject({
      collected_periods: 0,
      balance: total.toString(),
      status: "active",
      last_collection: null,
    });
    await webhook("mandate.updated", md.id, (o) => Number(o.collect_failures) >= 1);
    const open = (await getInv(first)) as AutoDebitInvoice;
    expect(open.status).toBe("open");
    expect(open.mandate_collection ?? null).toBeNull();

    if (!slow) return;
    // keeper §7.1: ≥ 60 s between attempts; after 5 consecutive failures the invoice is emailed instead
    const t = Date.now() - 2000;
    const fallback = (await invoiceUntil(
      first,
      (i) => (i as AutoDebitInvoice).collection_method === "send_invoice" && i.status === "open",
      12 * 60_000,
      "fallback after 5 collect failures",
    )) as AutoDebitInvoice;
    expect((await getMd(md.id)).collect_failures).toBeGreaterThanOrEqual(5);
    await webhook("invoice.sent", fallback.id, undefined, 120_000);
    // billing sends at most one mail per invoice per 10 minutes (lld/billing.md §5): five attempts ≥ 60 s apart
    // usually fall back inside that window, so the customer's mail is the one from the invoice's creation
    const mailedSince = Date.now() - created < 10 * 60_000 ? created : t;
    await customerMail(email, new RegExp(`^Invoice ${fallback.number} from `), mailedSince);
    // collect failures are the merchant side's problem, not the payer's balance
    expect(await demo().events({ type: "mandate.insufficient_funds", object: md.id })).toEqual([]);
  });

  it("92 fee leg fails → collected with fee 0, invoice paid, the fee stays in the balance", async () => {
    const amount = "10000092";
    const { md, first, total } = await funded("vault-92", amount);
    const share = expectedShare(amount, md.fee_bps);
    const c = await mandateUntil(md.id, (m) => m.collected_periods === 1, "period 1 collected", COLLECT_MS);
    expect(c.last_collection).toMatchObject({ period: 1, merchant_share: share.toString(), fee: "0", short: false });
    expect(c.balance).toBe((total - share).toString());
    const paid = (await invoiceUntil(first, (i) => i.status === "paid", COLLECT_MS, "paid")) as AutoDebitInvoice;
    expect(paid.mandate_collection).toMatchObject({
      mandate: md.id,
      period: 1,
      merchant_share: share.toString(),
      fee: "0",
    });
    await webhook("mandate.collected", md.id);
  });

  it("93 first refund fails → canceled with refunded 0, balance kept → withdraw empties it", async () => {
    const amount = "10000093";
    const { md, first, total } = await funded("vault-93", amount, 2);
    await mandateUntil(md.id, (m) => m.collected_periods === 1, "period 1 collected", COLLECT_MS);
    await invoiceUntil(first, (i) => i.status === "paid", COLLECT_MS, "paid");
    const rest = (total - BigInt(amount)).toString();

    const cancel = await payerAction(md.id, "cancel");
    expect(cancel.accepted).toBe(true);
    const canceled = await mandateUntil(md.id, (m) => m.status === "canceled", "canceled");
    expect(canceled.canceled).toMatchObject({ by_role: "payer", refunded: "0" });
    expect(canceled).toMatchObject({ balance: rest, collecting: false });
    await webhook("mandate.canceled", md.id);

    const w = await payerAction(md.id, "withdraw");
    expect(w).toMatchObject({ action: "withdraw", accepted: true, rejection: null });
    expect(vaultEvents(w.logs)).toContain("withdrawn");
    const done = await mandateUntil(md.id, (m) => m.balance === "0", "withdrawn");
    expect(done.withdrawn).toBe(rest);
    await webhook("mandate.updated", md.id, (o) => o.withdrawn === rest);
  });

  it("94 partial delivery → short share: invoice voided with the collection, balance invoice sent", async () => {
    const amount = "10000094";
    const { md, first, total, sub, email, receiverBefore } = await funded("vault-94", amount);
    expect(md.receiver_kind).toBe("intents_account");
    const short = expectedShare(amount, md.fee_bps) / 2n;
    const t = Date.now() - 2000;
    const c: Mandate = await mandateUntil(md.id, (m) => m.collected_periods === 1, "period 1 collected", COLLECT_MS);
    expect(c.last_collection).toMatchObject({ period: 1, merchant_share: short.toString(), fee: "0", short: true });
    expect(c.balance).toBe((total - short).toString());
    await webhook("mandate.collected", md.id, (o) => (o.last_collection as { short?: boolean } | null)?.short === true);
    expect(intentsBalance(md.merchant_receiver) - receiverBefore).toBeGreaterThanOrEqual(short);

    const voided = (await invoiceUntil(
      first,
      (i) => i.status === "void",
      COLLECT_MS,
      "voided after a short share",
    )) as AutoDebitInvoice;
    expect(voided.mandate_collection).toMatchObject({ mandate: md.id, period: 1, merchant_share: short.toString() });
    const balance = (
      await until(
        () => invoicesOf(sub.id),
        (l) => l.some((i) => i.id !== first && i.billing_reason === "manual" && i.status === "open"),
        90_000,
        "balance invoice",
      )
    ).find((i) => i.id !== first && i.billing_reason === "manual") as AutoDebitInvoice;
    expect(balance).toMatchObject({ collection_method: "send_invoice", subscription: sub.id });
    expect(BigInt(balance.amount_remaining)).toBeGreaterThan(0n);
    await webhook("invoice.sent", balance.id);
    await customerMail(email, new RegExp(`^Invoice ${balance.number} from `), t);
  });
});
