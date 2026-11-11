/**
 * Stage 3 scenario 1 — invoice lifecycle (lld/billing.md, development plan §5 step 3.4 "invoice paid from Solana/EVM
 * into a NEAR destination"): product, price, tax rate, customer → draft → finalize → send → `invoice.issued` mail with
 * the hosted link (Mailpit) → the customer pays on the hosted-invoice session from an EVM origin (USDC on Base;
 * a second invoice from Solana), attested by sentinel → evidence-backed `payment_intent.succeeded` → `invoice.paid`
 * webhook (verified by merchant-demo), "Payment received" mail, PDF stamped PAID. Then the void and uncollectible
 * paths (an uncollectible invoice can still be paid, INV-3). The browser half (`/i/:id`) is hosted-invoice.pw.ts.
 */
import {
  API_VERSION,
  getInvoicePdf,
  getPaymentIntent,
  getPublicInvoice,
  getPublicInvoicePdf,
  HEADERS,
  markInvoiceUncollectible,
  voidInvoice,
} from "@nearpay-money/spec";
import { beforeAll, describe, expect, it } from "vitest";
import { ApiError, call, routeUrl } from "../../lib/http.js";
import { md, realStack, stack, WEBHOOK_TIMEOUT_MS } from "../support/env.js";
import { api } from "../support/stage2.js";
import {
  catalogue,
  customerMail,
  ensureStage3Webhooks,
  getInv,
  hostedLinkIn,
  type Invoice,
  invoiceSecret,
  invoiceUntil,
  payInvoice,
  sentInvoice,
  TEST_REFUND_SOLANA,
  USDC_SOLANA,
} from "../support/stage3.js";

const PAY_MS = 3 * 60_000;

/** The invoice PDF as text (billing writes uncompressed PDF 1.4 content streams). */
async function pdfText(o: { merchant: true; id: string } | { merchant: false; id: string; secret: string }) {
  const st = stack();
  const url = o.merchant
    ? routeUrl(getInvoicePdf, { base: st.apiUrl, params: { id: o.id } })
    : routeUrl(getPublicInvoicePdf, { base: st.payerApiUrl, params: { id: o.id } });
  const res = await fetch(url, {
    headers: {
      [HEADERS.apiVersion]: API_VERSION,
      ...(o.merchant ? { [HEADERS.authorization]: `Bearer ${st.secretKey()}` } : { [HEADERS.invoiceSecret]: o.secret }),
    },
  });
  expect(
    res.status,
    await res
      .clone()
      .text()
      .then((t) => t.slice(0, 200)),
  ).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/application\/pdf/);
  const text = Buffer.from(await res.arrayBuffer()).toString("latin1");
  expect(text.startsWith("%PDF-")).toBe(true);
  return text;
}

const webhook = (type: string, object: string) => md().waitForEvent({ type, object }, WEBHOOK_TIMEOUT_MS);

describe.skipIf(!realStack)("Stage 3 · invoices", () => {
  let cat: Awaited<ReturnType<typeof catalogue>>;
  beforeAll(async () => {
    await ensureStage3Webhooks();
    cat = await catalogue("inv");
  });

  it("send → issued mail with the hosted link → paid from Base (EVM) → invoice.paid, receipt mail, PDF PAID", async () => {
    const t0 = Date.now() - 2000;
    const inv = await sentInvoice(cat, "inv-evm");
    expect(inv).toMatchObject({ status: "open", livemode: false, customer: cat.customer });
    expect(inv.number).toBeTruthy();
    // 10 + 19 % VAT, exclusive: exact integer arithmetic (USD minor units)
    expect(Number(inv.total)).toBe(1190);
    for (const t of ["invoice.created", "invoice.finalized", "invoice.sent"]) await webhook(t, inv.id);

    const issued = await customerMail(cat.email, new RegExp(`^Invoice ${inv.number} from .*\\[test\\]$`), t0);
    const link = hostedLinkIn(issued, inv.id);
    expect(link).toBe(inv.hosted_invoice_url);
    expect(new URL(link).origin).toBe(stack().payUrl);

    // the hosted page's view: no merchant credential, only the invoice secret
    const pub = await call<{ id: string; status: string }>(getPublicInvoice, {
      base: stack().payerApiUrl,
      params: { id: inv.id },
      headers: { [HEADERS.invoiceSecret]: invoiceSecret(link) },
    });
    expect(pub).toMatchObject({ id: inv.id, status: "open" });
    await expect(
      call(getPublicInvoice, {
        base: stack().payerApiUrl,
        params: { id: inv.id },
        headers: { [HEADERS.invoiceSecret]: `${invoiceSecret(link).slice(0, -4)}AAAA` },
      }),
    ).rejects.toBeInstanceOf(ApiError);

    const paid = await payInvoice(link);
    expect(paid.merchant.name).toBeTruthy();
    expect(paid.fingerprint).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{2}$/);

    const done = await invoiceUntil(inv.id, (i) => i.status === "paid", PAY_MS, "paid");
    expect(Number(done.amount_remaining)).toBe(0);
    expect(done.payment_intent).toBeTruthy();
    // INV-2: paid only on evidence — the intent succeeded with an evidence-backed attempt and points at the invoice
    const pi = await api<{ status: string; invoice: string | null; amount_settled: string }>(getPaymentIntent, {
      params: { id: done.payment_intent as string },
    });
    expect(pi).toMatchObject({ status: "succeeded", invoice: inv.id });
    expect(BigInt(pi.amount_settled)).toBeGreaterThan(0n);

    const ev = await webhook("invoice.paid", inv.id);
    expect(ev.event.data.object).toMatchObject({ id: inv.id, status: "paid" });
    await customerMail(cat.email, new RegExp(`^Payment received: invoice ${inv.number} from `), t0);

    expect(await pdfText({ merchant: true, id: inv.id })).toContain("(PAID)");
    expect(await pdfText({ merchant: false, id: inv.id, secret: invoiceSecret(link) })).toContain("(PAID)");
  });

  it("paid from Solana into the NEAR destination", async () => {
    const inv = await sentInvoice(cat, "inv-sol");
    await payInvoice(inv.hosted_invoice_url as string, { originAssetId: USDC_SOLANA, refundTo: TEST_REFUND_SOLANA });
    const done = await invoiceUntil(inv.id, (i) => i.status === "paid", PAY_MS, "paid");
    expect(Number(done.amount_paid)).toBe(Number(done.total));
    await webhook("invoice.paid", inv.id);
  });

  it("void: invoice.voided, voided mail, hosted page refuses payment, PDF VOID", async () => {
    const t0 = Date.now() - 2000;
    const inv = await sentInvoice(cat, "inv-void");
    const link = inv.hosted_invoice_url as string;
    const voided = await api<Invoice>(voidInvoice, { params: { id: inv.id }, body: {} });
    expect(voided.status).toBe("void");
    await webhook("invoice.voided", inv.id);
    await customerMail(cat.email, new RegExp(`^Invoice ${inv.number} from .* was voided`), t0);
    await expect(payInvoice(link)).rejects.toMatchObject({ status: 409 });
    expect(await pdfText({ merchant: true, id: inv.id })).toContain("(VOID)");
    // a void invoice is final
    await expect(api(voidInvoice, { params: { id: inv.id }, body: {} })).rejects.toMatchObject({ status: 409 });
  });

  it("uncollectible: invoice.marked_uncollectible, PDF stamped, and a late payment still lands (INV-3)", async () => {
    const inv = await sentInvoice(cat, "inv-unc");
    const unc = await api<Invoice>(markInvoiceUncollectible, { params: { id: inv.id }, body: {} });
    expect(unc.status).toBe("uncollectible");
    await webhook("invoice.marked_uncollectible", inv.id);
    expect(await pdfText({ merchant: true, id: inv.id })).toContain("(UNCOLLECTIBLE)");
    await payInvoice(inv.hosted_invoice_url as string);
    const done = await invoiceUntil(inv.id, (i) => i.status === "paid", PAY_MS, "paid after uncollectible");
    expect(Number(done.amount_remaining)).toBe(0);
    await webhook("invoice.paid", inv.id);
    expect((await getInv(inv.id)).status).toBe("paid");
  });
});
