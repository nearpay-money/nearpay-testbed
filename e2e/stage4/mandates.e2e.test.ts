/**
 * Stage 4 scenario 1 — auto-debit end to end in test mode (development plan §6 step 4.4: "payer funds a mandate,
 * keeper collects period 1, merchant receives into its Intents account, payer cancels and withdraws the remainder";
 * lld/billing.md §5–§7.1, §14–§15; lld/sandbox.md §3.1 vault stand-in, OQ-T-03):
 *
 * a) USD subscription (`auto_debit`, USD 10.00/month at par in USDC): the first invoice is emailed with auto-debit
 *    offered on its hosted page → `prepareMandate` and the hosted page's funding compute the same instructions without
 *    side effects → the simulated payer funds 3 periods through the stand-in's `ft_transfer_call` → `mandate_created`
 *    forwarded by rails → `mandate.activated` (linked, collecting) → the keeper collects period 1 → the first invoice
 *    is paid with `mandate_collection` evidence (no payment intent) and the merchant's Intents balance grows by the
 *    merchant share → renewal on the test clock (billing also moves the mandate's vault clock) → period 2 collected
 *    without an email → withdraw while active is refused by the vault (`ERR_STILL_ACTIVE`) → payer cancel →
 *    `mandate.canceled` refunds the remainder, collection stops (subscription loses the mandate) → withdraw has
 *    nothing left → payer mails (activated, canceled).
 * b) insufficient funds (asset-priced, one period funded): period 1 collected → balance below one period
 *    (`insufficient`) → renewal → the keeper's collect fails with `ERR_INSUFFICIENT_BALANCE` →
 *    `mandate.insufficient_funds` + payer mail → the renewal invoice falls back to `send_invoice` and is emailed →
 *    paid on the hosted page; a top-up makes the mandate `active` again (`mandate.updated`).
 */
import {
  advanceSubscriptionClock,
  createPublicInvoiceMandateFunding,
  getPublicInvoiceMandate,
  HEADERS,
  listInvoices,
  prepareMandate,
} from "@nearpay-money/spec";
import { beforeAll, describe, expect, it } from "vitest";
import { call } from "../../lib/http.js";
import { realStack, stack } from "../support/env.js";
import { api, until } from "../support/stage2.js";
import {
  customerMail,
  getInv,
  hostedLinkIn,
  invoiceSecret,
  invoiceUntil,
  payInvoice,
  USDC_NEAR,
} from "../support/stage3.js";
import {
  type AutoDebitInvoice,
  autoDebitSubscription,
  ensureStage4Webhooks,
  expectedShare,
  fundMandate,
  getSub,
  intentsBalance,
  MANDATE_MAIL,
  MONTH_SECS,
  mandateFor,
  mandatesOf,
  mandateUntil,
  payerAction,
  SANDBOX_PAYER,
  SANDBOX_VAULT,
  USDC_NEAR_TOKEN,
  vaultEvents,
  webhook,
} from "../support/stage4.js";

const COLLECT_MS = 3 * 60_000;
const PAY_MS = 3 * 60_000;
const inv = (id: string) => getInv(id) as Promise<AutoDebitInvoice>;
const invoicesOf = (sub: string) =>
  api<{ data: AutoDebitInvoice[] }>(listInvoices, { query: { subscription: sub, limit: "20" } }).then((l) => l.data);
const advance = (id: string, target: "renewal_upcoming" | "renewal" | "overdue") =>
  api<{ target: string; advanced_by: number }>(advanceSubscriptionClock, { params: { id }, body: { target } });
const newInvoiceOf = async (sub: string, known: readonly string[], what: string) =>
  (
    await until(
      () => invoicesOf(sub),
      (l) => l.some((i) => !known.includes(i.id) && i.status !== "draft"),
      90_000,
      what,
    )
  ).find((i) => !known.includes(i.id) && i.status !== "draft") as AutoDebitInvoice;

describe.skipIf(!realStack)("Stage 4 · auto-debit (sandbox vault stand-in)", () => {
  beforeAll(async () => {
    await ensureStage4Webhooks();
  });

  it("a) fund → activated → period 1 collected (evidence, merchant receives) → renewal collected → cancel → withdraw", async () => {
    const t0 = Date.now() - 2000;
    const { sub, email } = await autoDebitSubscription("autodebit", { usdCents: 1000 });
    expect(sub).toMatchObject({ collection_method: "auto_debit", status: "incomplete" });
    const first = await inv(sub.latest_invoice as string);
    // without a mandate the first invoice is emailed; its hosted page offers the setup (billing §15 d12)
    expect(first).toMatchObject({
      status: "open",
      collection_method: "send_invoice",
      billing_reason: "subscription_create",
    });
    const firstMail = await customerMail(email, new RegExp(`^Invoice ${first.number} from `), t0);
    const hosted = hostedLinkIn(firstMail, first.id);

    // prepare: deterministic, no side effects (a mandate exists only from the chain event)
    const prep = await api<{
      vault_contract: string;
      token: string;
      asset_id: string;
      amount: string;
      periods: number;
      amount_per_period: string;
      period_secs: number;
      start_at: string | null;
      fee_bps: number;
      merchant_receiver: string;
      receiver_kind: string;
      ext_ref: string;
      msg: string;
      payer_notice: string;
      transactions: {
        signer_id: string | null;
        receiver_id: string;
        actions: { method_name: string; args: Record<string, unknown>; gas: string; deposit: string }[];
      }[];
    }>(prepareMandate, { body: { subscription: sub.id, periods: 3 } });
    expect(prep).toMatchObject({
      vault_contract: SANDBOX_VAULT,
      token: USDC_NEAR_TOKEN,
      asset_id: USDC_NEAR,
      amount_per_period: "10000000",
      amount: "30000000",
      periods: 3,
      period_secs: MONTH_SECS,
      start_at: null, // the latest invoice is open: period 1 is due at once and pays it
      receiver_kind: "intents_account",
      ext_ref: sub.id,
    });
    expect(JSON.parse(prep.msg)).toEqual({
      create_mandate: {
        merchant_receiver: prep.merchant_receiver,
        receiver_kind: "intents_account",
        amount_per_period: "10000000",
        period_secs: MONTH_SECS,
        start_at: null, // serde Option fields are explicit nulls (spec test-vectors/vault.json)
        max_periods: null,
        fee_bps: prep.fee_bps,
        ext_ref: sub.id,
      },
    });
    const ftCall = prep.transactions.at(-1);
    expect(ftCall).toMatchObject({ signer_id: null, receiver_id: USDC_NEAR_TOKEN });
    expect(ftCall?.actions[0]).toMatchObject({
      method_name: "ft_transfer_call",
      args: { receiver_id: SANDBOX_VAULT, amount: "30000000", msg: prep.msg },
      gas: "100000000000000",
      deposit: "1",
    });
    expect(prep.payer_notice).toMatch(/own NEAR account/);
    // the hosted invoice page computes the same funding with the invoice secret (anonymous)
    const pay = stack().payerApiUrl;
    const secretHeader = { [HEADERS.invoiceSecret]: invoiceSecret(hosted) };
    const pageFunding = await call<{ msg: string; amount: string }>(createPublicInvoiceMandateFunding, {
      base: pay,
      params: { id: first.id },
      headers: secretHeader,
      body: { periods: 3 },
    });
    expect(pageFunding).toMatchObject({ msg: prep.msg, amount: prep.amount });
    expect(await mandatesOf(sub.id)).toEqual([]);

    // the payer funds from its own account: ft_transfer_call → vault ft_on_transfer → mandate_created
    const receiverBefore = intentsBalance(prep.merchant_receiver);
    const t1 = Date.now() - 2000;
    const funded = await fundMandate(sub.id, 3);
    expect(funded).toMatchObject({ action: "fund", accepted: true, rejection: null });
    expect(vaultEvents(funded.logs)).toContain("mandate_created");
    const md0 = await mandateFor(sub.id);
    expect(md0).toMatchObject({
      livemode: false,
      link_status: "linked",
      unlinked_reason: null,
      subscription: sub.id,
      vault_contract: SANDBOX_VAULT,
      onchain_id: funded.onchain_id,
      payer: SANDBOX_PAYER,
      token: USDC_NEAR_TOKEN,
      merchant_receiver: prep.merchant_receiver,
      amount_per_period: "10000000",
      period_secs: MONTH_SECS,
      fee_bps: prep.fee_bps,
      ext_ref: sub.id,
    });
    await webhook("mandate.activated", md0.id, (o) => o.link_status === "linked");
    await customerMail(email, MANDATE_MAIL, t1);

    // keeper: period 1 is due at once → collect → forwarded `collected` → the open invoice is paid by it
    const share = expectedShare("10000000", prep.fee_bps);
    const md1 = await mandateUntil(md0.id, (m) => m.collected_periods === 1, "period 1 collected", COLLECT_MS);
    expect(md1.last_collection).toMatchObject({
      period: 1,
      amount: "10000000",
      merchant_share: share.toString(),
      fee: (10_000_000n - share).toString(),
      short: false,
      invoice: first.id,
    });
    expect(md1).toMatchObject({
      status: "active",
      collecting: true,
      balance: "20000000",
      funded_periods: 2,
      collect_failures: 0,
    });
    await webhook("mandate.collected", md0.id, (o) => o.collected_periods === 1);
    const paid1 = (await invoiceUntil(
      first.id,
      (i) => i.status === "paid",
      COLLECT_MS,
      "paid by period 1",
    )) as AutoDebitInvoice;
    expect(paid1).toMatchObject({ collection_method: "auto_debit", mandate: md0.id, payment_intent: null });
    expect(paid1.mandate_collection).toMatchObject({
      mandate: md0.id,
      period: 1,
      token: USDC_NEAR,
      merchant_share: share.toString(),
      tx_hash: md1.last_collection?.tx_hash,
      receipt_id: md1.last_collection?.receipt_id,
    });
    await webhook("invoice.paid", first.id);
    // the merchant share landed in the merchant's NEAR Intents account (other suites only add to it)
    expect(intentsBalance(prep.merchant_receiver) - receiverBefore).toBeGreaterThanOrEqual(share);
    const active = await until(
      () => getSub(sub.id),
      (s) => s.status === "active",
      90_000,
      `${sub.id} active`,
    );
    expect(active.mandate).toBe(md0.id);

    // renewal: an auto_debit invoice (not emailed) that the keeper collects as period 2
    await advance(sub.id, "renewal");
    const renewal = await newInvoiceOf(sub.id, [first.id], "renewal invoice");
    expect(renewal).toMatchObject({
      billing_reason: "subscription_cycle",
      collection_method: "auto_debit",
      mandate: md0.id,
    });
    await mandateUntil(
      md0.id,
      (m) => m.collected_periods === 2 && m.balance === "10000000",
      "period 2 collected",
      COLLECT_MS,
    );
    const paid2 = (await invoiceUntil(
      renewal.id,
      (i) => i.status === "paid",
      COLLECT_MS,
      "paid by period 2",
    )) as AutoDebitInvoice;
    expect(paid2.mandate_collection).toMatchObject({ mandate: md0.id, period: 2 });
    // the payer sees it on the hosted page with its cancel transaction (still active, nothing to withdraw)
    const page = await call<{
      id: string;
      collected_periods: number;
      transactions: { cancel: unknown; withdraw: unknown };
    }>(getPublicInvoiceMandate, { base: pay, params: { id: first.id }, headers: secretHeader });
    expect(page).toMatchObject({ id: md0.id, collected_periods: 2 });
    expect(page.transactions.cancel).toMatchObject({ receiver_id: SANDBOX_VAULT });
    expect(page.transactions.withdraw).toBeNull();

    // the vault refuses a withdraw while the mandate is active (its error comes back as a rejection, not an API error)
    const early = await payerAction(md0.id, "withdraw");
    expect(early).toMatchObject({ accepted: false });
    expect(early.rejection).toMatch(/ERR_STILL_ACTIVE/);

    // payer cancel: the remainder goes back to the payer; collection stops for good
    const t2 = Date.now() - 2000;
    const canceled = await payerAction(md0.id, "cancel");
    expect(canceled).toMatchObject({ action: "cancel", accepted: true });
    expect(vaultEvents(canceled.logs)).toContain("canceled");
    const md3 = await mandateUntil(md0.id, (m) => m.status === "canceled", "canceled");
    expect(md3).toMatchObject({ collecting: false, balance: "0", collected_periods: 2 });
    expect(md3.canceled).toMatchObject({ by: SANDBOX_PAYER, by_role: "payer", refunded: "10000000" });
    await webhook("mandate.canceled", md0.id);
    await customerMail(email, MANDATE_MAIL, t2);
    const after = await until(
      () => getSub(sub.id),
      (s) => !s.mandate,
      90_000,
      `${sub.id} without mandate`,
    );
    expect(after.status).toBe("active");

    // nothing is left to withdraw after a full refund (the closed, empty mandate is gone from the vault's state)
    const late = await payerAction(md0.id, "withdraw");
    expect(late.accepted).toBe(false);
    expect(late.rejection).toMatch(/ERR_(NOT_FOUND|INSUFFICIENT_BALANCE)/);
    expect((await mandateUntil(md0.id, () => true, "final")).withdrawn).toBe("0");
  });

  it("b) insufficient funds: renewal collect fails → mandate.insufficient_funds → emailed invoice paid → top-up", async () => {
    const { sub, email } = await autoDebitSubscription("autodebit-low", { assetAmount: "5000000" });
    await fundMandate(sub.id, 1);
    const md0 = await mandateFor(sub.id);
    await webhook("mandate.activated", md0.id);
    const md1 = await mandateUntil(md0.id, (m) => m.collected_periods === 1, "period 1 collected", COLLECT_MS);
    expect(md1).toMatchObject({ status: "insufficient", balance: "0", funded_periods: 0, collecting: true });
    await invoiceUntil(sub.latest_invoice as string, (i) => i.status === "paid", COLLECT_MS, "first invoice paid");

    const t1 = Date.now() - 2000;
    await advance(sub.id, "renewal");
    const renewal = await newInvoiceOf(sub.id, [sub.latest_invoice as string], "renewal invoice");
    await webhook("mandate.insufficient_funds", md0.id, undefined, COLLECT_MS);
    await customerMail(email, MANDATE_MAIL, t1);
    // the keeper gives up on this invoice: it becomes a send_invoice invoice and is emailed
    const fallback = (await invoiceUntil(
      renewal.id,
      (i) => (i as AutoDebitInvoice).collection_method === "send_invoice",
      COLLECT_MS,
      "fallback to send_invoice",
    )) as AutoDebitInvoice;
    expect(fallback.status).toBe("open");
    await webhook("invoice.sent", renewal.id);
    const mail = await customerMail(email, new RegExp(`^Invoice ${renewal.number} from `), t1);
    await payInvoice(hostedLinkIn(mail, renewal.id));
    const paid = (await invoiceUntil(
      renewal.id,
      (i) => i.status === "paid",
      PAY_MS,
      "paid on the hosted page",
    )) as AutoDebitInvoice;
    expect(paid.payment_intent).toBeTruthy();
    expect(paid.mandate_collection ?? null).toBeNull();

    // a top-up covers the next period again
    const top = await payerAction(md0.id, "top_up", 1);
    expect(top).toMatchObject({ action: "top_up", accepted: true });
    expect(vaultEvents(top.logs)).toContain("topped_up");
    await mandateUntil(md0.id, (m) => m.status === "active" && m.balance === "5000000", "topped up");
    await webhook("mandate.updated", md0.id, (o) => o.balance === "5000000");
  });
});
