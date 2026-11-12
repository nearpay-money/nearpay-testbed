/**
 * Stage 3 E2E helpers (step 3.4): the billing catalogue, invoices and subscriptions of the demo merchant (seeded
 * secret key), paying an invoice the way its customer does (hosted-invoice session → attested `route_quote` attempt
 * from an EVM/Solana origin → "Simulate payment"), customer mails in Mailpit, the demo merchant's destination, and a
 * fresh dashboard merchant with a test-mode destination (the CLI login account).
 */
import { randomUUID } from "node:crypto";
import {
  attestSettlementDestination,
  createCustomer,
  createInvoice,
  createPrice,
  createProduct,
  createPublicInvoiceSession,
  createSettlementDestination,
  createSubscription,
  createTaxRate,
  finalizeInvoice,
  getInvoice,
  getSettlementDestination,
  HEADERS,
  InvoiceSecret,
  listSettlementDestinations,
  sendInvoice,
} from "@nearpay-money/spec";
import { ed25519 } from "@noble/curves/ed25519.js";
import { ensureDestinationActive } from "../../lib/destinations.js";
import { call } from "../../lib/http.js";
import { base58Encode, signNep413 } from "../../lib/onboard.js";
import { DashboardSession } from "../../lib/ops-console.js";
import { type AttestedAttempt, payBySimulatedDeposit, TURNSTILE_TEST_TOKEN, USDC_BASE } from "../../lib/payer.js";
import { ops, stack } from "./env.js";
import { api, ensureWebhookEvents, mail, until } from "./stage2.js";

export const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const USDC_SOLANA = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
/** A valid Solana address for refunds in test mode (never receives anything real). */
export const TEST_REFUND_SOLANA = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
export { USDC_BASE };

export const INVOICE_EVENTS = [
  "invoice.created",
  "invoice.finalized",
  "invoice.sent",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.overdue",
  "invoice.voided",
  "invoice.marked_uncollectible",
] as const;
export const SUBSCRIPTION_EVENTS = [
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.renewal_upcoming",
] as const;

/** The merchant-demo endpoint receives every Stage 3 type (seed.sh data adds them; older seeds are patched here). */
export const ensureStage3Webhooks = () => ensureWebhookEvents([...INVOICE_EVENTS, ...SUBSCRIPTION_EVENTS]);

export interface Invoice {
  id: string;
  status: string;
  number: string | null;
  customer: string;
  subscription: string | null;
  billing_reason: string;
  total: number | string;
  amount_paid: number | string;
  amount_remaining: number | string;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  checkout_session: string | null;
  payment_intent: string | null;
  due_date: number | null;
  livemode: boolean;
}

export interface Subscription {
  id: string;
  status: string;
  latest_invoice: string | null;
  current_period_start: number;
  current_period_end: number;
  cancel_at_period_end: boolean;
}

/** A unique, routable customer mailbox (Mailpit catches everything). */
export const customerEmail = (tag: string) => `${tag}-${randomUUID().slice(0, 8)}@customer.test`;

/** Product + one-time and monthly USD prices + an exclusive tax rate + a customer, tagged for this run. */
export async function catalogue(tag: string, o: { unitAmount?: number } = {}) {
  const meta = { testbed: tag };
  const product = await api<{ id: string }>(createProduct, { body: { name: `Testbed ${tag}`, metadata: meta } });
  const oneTime = await api<{ id: string }>(createPrice, {
    body: { product: product.id, unit_amount: o.unitAmount ?? 1000, currency: "usd", metadata: meta },
  });
  const monthly = await api<{ id: string }>(createPrice, {
    body: {
      product: product.id,
      unit_amount: o.unitAmount ?? 1000,
      currency: "usd",
      recurring: { interval: "month" },
      metadata: meta,
    },
  });
  const tax = await api<{ id: string; percentage: string }>(createTaxRate, {
    body: { display_name: "VAT", percentage: "19", inclusive: false, jurisdiction: "DE", metadata: meta },
  });
  const email = customerEmail(tag);
  const customer = await api<{ id: string; email: string }>(createCustomer, {
    body: { email, name: `Customer ${tag}`, metadata: meta },
  });
  return { product: product.id, oneTime: oneTime.id, monthly: monthly.id, tax: tax.id, customer: customer.id, email };
}

/** Draft → finalize → send (returns the sent invoice). */
export async function sentInvoice(
  cat: { customer: string; oneTime: string; tax?: string },
  tag: string,
): Promise<Invoice> {
  const draft = await api<Invoice>(createInvoice, {
    body: {
      customer: cat.customer,
      lines: [{ price: cat.oneTime, quantity: 1 }],
      ...(cat.tax ? { default_tax_rates: [cat.tax] } : {}),
      description: `testbed ${tag}`,
      metadata: { testbed: tag },
    },
  });
  expect_(draft.status === "draft", `new invoice is ${draft.status}`);
  const open = await api<Invoice>(finalizeInvoice, { params: { id: draft.id }, body: {} });
  expect_(open.status === "open" && !!open.hosted_invoice_url, `finalized invoice: ${open.status}`);
  return api<Invoice>(sendInvoice, { params: { id: draft.id }, body: {} });
}

export const getInv = (id: string) => api<Invoice>(getInvoice, { params: { id } });

/** Polls the invoice until `done`. */
export const invoiceUntil = (id: string, done: (i: Invoice) => boolean, ms: number, what: string) =>
  until(() => getInv(id), done, ms, `${id} ${what}`);

/** The invoice secret from `<pay origin>/i/<id>#<secret>`. */
export function invoiceSecret(url: string): string {
  const secret = decodeURIComponent(new URL(url).hash.slice(1));
  if (!InvoiceSecret.safeParse(secret).success) throw new Error(`no invoice secret in ${url}`);
  return secret;
}

/** The hosted invoice link in a customer mail. */
export function hostedLinkIn(text: string, invoiceId: string): string {
  const m = new RegExp(`https://[^\\s"'<>]+/i/${invoiceId}#[^\\s"'<>)\\]]+`).exec(text);
  if (!m) throw new Error(`no hosted link for ${invoiceId} in the mail`);
  return m[0];
}

/**
 * Pays an invoice like its customer on the hosted page: invoice secret → hosted-invoice session (payer API on the pay
 * host) → sentinel-attested `route_quote` attempt from `originAssetId` → simulated deposit.
 */
export async function payInvoice(
  hostedUrl: string,
  o: { originAssetId?: string; refundTo?: string } = {},
): Promise<AttestedAttempt & { checkoutSession: string }> {
  const st = stack();
  const id = /\/i\/(in_[0-9a-z]+)/.exec(hostedUrl)?.[1];
  if (!id) throw new Error(`not a hosted invoice URL: ${hostedUrl}`);
  const s = await call<{ checkout_session: string; client_secret: string }>(createPublicInvoiceSession, {
    base: st.payerApiUrl,
    params: { id },
    headers: { [HEADERS.invoiceSecret]: invoiceSecret(hostedUrl) },
    body: {},
  });
  const paid = await payBySimulatedDeposit(
    {
      apiBase: st.payerApiUrl,
      pinnedKeys: st.pinnedKeys(),
      sessionId: s.checkout_session,
      clientSecret: s.client_secret,
    },
    {
      originAssetId: o.originAssetId ?? USDC_BASE,
      ...(o.refundTo ? { refundTo: o.refundTo } : {}),
    },
  );
  return { ...paid, checkoutSession: s.checkout_session };
}

/** Subscription on the monthly price, invoiced by mail (no trial: the first invoice is sent at once). */
export async function subscribe(cat: { customer: string; monthly: string; tax?: string }, tag: string) {
  return api<Subscription>(createSubscription, {
    body: {
      customer: cat.customer,
      items: [{ price: cat.monthly }],
      days_until_due: 7,
      ...(cat.tax ? { default_tax_rates: [cat.tax] } : {}),
      metadata: { testbed: tag },
    },
  });
}

/** Newest customer mail to `to` whose subject matches (plain text), received after `after` (ms). */
export const customerMail = (to: string, subject: RegExp, after: number, timeoutMs = 60_000) =>
  mail().latest(to, subject, timeoutMs, after);

/** The demo merchant's active test-mode Intents destination (its address is the x402 / MCP `payTo`). */
export async function demoDestination(): Promise<{ id: string; address: string; asset_id: string }> {
  const list = await api<{ data: { id: string; address: string; asset_id: string; status: string; type: string }[] }>(
    listSettlementDestinations,
    { query: { limit: "100" } },
  );
  const d = list.data.find((x) => x.status === "active" && x.type === "intents_account" && x.asset_id === USDC_NEAR);
  if (!d) throw new Error("the demo merchant has no active test USDC Intents destination (run seed.sh data)");
  return d;
}

/**
 * A new merchant signed up on the dashboard (software passkey) with an active test-mode NEAR Intents destination
 * proven with NEP-413 — the account a `nearpay login` key belongs to.
 */
export async function newMerchant(
  tag: string,
): Promise<{ session: DashboardSession; email: string; destination: string }> {
  const st = stack();
  const email = `${tag}-${randomUUID().slice(0, 8)}@merchant.test`;
  const session = await DashboardSession.signUp(st.dashboardUrl, {
    email,
    displayName: `Testbed ${tag}`,
    mail: mail(),
    turnstileToken: TURNSTILE_TEST_TOKEN,
  });
  const seed = ed25519.utils.randomSecretKey();
  const pub = ed25519.getPublicKey(seed);
  const key = { accountId: Buffer.from(pub).toString("hex"), publicKey: `ed25519:${base58Encode(pub)}`, seed };
  session.mode = "test";
  const d = await session.call<{
    id: string;
    status: string;
    attestation_challenge?: { id: string; message: string; recipient: string; nonce: string } | null;
  }>(createSettlementDestination, {
    body: {
      asset_id: USDC_NEAR,
      type: "intents_account",
      chain: "near:mainnet",
      address: key.accountId,
      label: "Test (E2E)",
    },
  });
  if (d.attestation_challenge) {
    const ch = d.attestation_challenge;
    await session.call(attestSettlementDestination, {
      params: { id: d.id },
      body: { challenge_id: ch.id, standard: "nep413", ...signNep413(key, ch) },
    });
  }
  await ensureDestinationActive({
    id: d.id,
    status: async () =>
      (await session.call<{ status: string }>(getSettlementDestination, { params: { id: d.id } })).status,
    skipCooloff: () => ops("identity-api", ["destination-cooloff-skip", d.id, "--actor", "testbed:e2e"]),
  });
  return { session, email, destination: d.id };
}

function expect_(ok: boolean, what: string): asserts ok {
  if (!ok) throw new Error(what);
}
