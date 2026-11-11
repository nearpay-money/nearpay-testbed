/**
 * Stage 4 E2E helpers (step 4.4): auto-debit through the sandbox vault stand-in (OQ-T-03, lld/sandbox.md §3.1,
 * lld/billing.md §5–§7.1 and §14–§15) and the Solana / Bitcoin payer paths (lld/checkout-and-js.md §11).
 *
 * The simulated payer funds, tops up, cancels and withdraws with the public test helpers
 * (`simulateMandateFunding`, `simulateMandatePayerAction`): billing prepares the funding exactly like
 * `prepareMandate` and submits it to the stand-in's `POST /sim/vault/ft_transfer_call` / `/sim/vault/call` as
 * `sandbox-payer.near`; the testbed has no service credential for the sandbox's internal routes, and the helper is
 * the path the CLI and the dashboard use too. Everything after the funding transaction is the real pipeline: vault
 * receipts → rails' indexer (`evt.rails.vault.event`) → billing's mirror and keeper → events → webhooks → notify.
 *
 * Vault scenarios follow the last two digits of `amount_per_period` in token base units (sandbox §4.2). USD prices
 * are paid at par (`cents × 10^4`), so they always end in `00`; the `91`–`94` scenarios use asset-priced prices
 * (`currency: asset`, USDC on NEAR, amounts 1:1).
 */
import {
  createPrice,
  createSubscription,
  getMandate,
  getSubscription,
  listMandates,
  parseVaultEventLog,
  simulateMandateFunding,
  simulateMandatePayerAction,
} from "@nearpay-money/spec";
import { md, ops, WEBHOOK_TIMEOUT_MS } from "./env.js";
import { api, ensureWebhookEvents, until } from "./stage2.js";
import {
  catalogue,
  INVOICE_EVENTS,
  type Invoice,
  SUBSCRIPTION_EVENTS,
  type Subscription,
  USDC_NEAR,
} from "./stage3.js";

/** NEAR USDC contract (the asset id without `nep141:`), an allowed token of the stand-in. */
export const USDC_NEAR_TOKEN = USDC_NEAR.slice("nep141:".length);
/** The stand-in vault account (= billing's test-mode `NP_VAULT_CONTRACT`, sandbox §3.1). */
export const SANDBOX_VAULT = "vault.sandbox.near";
/** The simulated NEAR payer of the test helpers (sandbox §4.1). */
export const SANDBOX_PAYER = "sandbox-payer.near";
/** `vaultPeriodSecs("month", 1)` (billing §14 d3). */
export const MONTH_SECS = 2_629_746;

export const SOL_NATIVE = "nep141:sol.omft.near";
export const BTC = "nep141:btc.omft.near";
/** USDC's SPL mint; `USDC_SOLANA` = `nep141:sol-<hex(keccak256(mint)[12..32])>.omft.near`. */
export const USDC_SOLANA_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** A valid Bitcoin refund address for test mode (the sandbox's simulated payer, sandbox §4.1). */
export const TEST_REFUND_BITCOIN = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

export const MANDATE_EVENTS = [
  "mandate.activated",
  "mandate.collected",
  "mandate.insufficient_funds",
  "mandate.canceled",
  "mandate.exhausted",
  "mandate.updated",
  "mandate.unlinked",
  "mandate.released",
] as const;

/** merchant-demo receives every Stage 3 and Stage 4 billing type. */
export const ensureStage4Webhooks = () =>
  ensureWebhookEvents([...INVOICE_EVENTS, ...SUBSCRIPTION_EVENTS, ...MANDATE_EVENTS]);

/**
 * Payer mails about a mandate (notify §4: activated, insufficient_funds, canceled, unlinked, released). Matched
 * loosely by subject; each check also requires a mail received after the action that causes it.
 */
export const MANDATE_MAIL = /auto-?debit|mandate/i;

export interface MandateCollection {
  period: number;
  amount: string;
  merchant_share: string;
  fee: string;
  short: boolean;
  invoice: string | null;
  tx_hash: string;
  receipt_id: string;
}

export interface Mandate {
  id: string;
  livemode: boolean;
  status: "active" | "insufficient" | "exhausted" | "canceled" | string;
  link_status: "linked" | "unlinked" | string;
  unlinked_reason: string | null;
  collecting: boolean;
  subscription: string;
  customer: string;
  vault_contract: string;
  onchain_id: number;
  payer: string;
  token: string;
  asset_id: string;
  merchant_receiver: string;
  receiver_kind: string;
  settlement_destination: string | null;
  amount_per_period: string;
  period_secs: number;
  max_periods: number | null;
  fee_bps: number;
  collected_periods: number;
  balance: string;
  funded_periods: number;
  next_collect_at: number | null;
  last_collection: MandateCollection | null;
  collect_failures: number;
  canceled: { by: string; by_role: string; refunded: string; canceled_at: number } | null;
  withdrawn: string;
  ext_ref: string;
  sequence: number;
}

export interface MandateSimulation {
  action: string;
  tx_hash: string;
  accepted: boolean;
  rejection: string | null;
  onchain_id: number | null;
  logs: string[];
}

export interface AutoDebitInvoice extends Invoice {
  collection_method: "send_invoice" | "auto_debit" | string;
  mandate?: string | null;
  mandate_collection?: {
    mandate: string;
    period: number;
    token: string;
    merchant_share: string;
    fee: string;
    tx_hash: string;
    receipt_id: string;
  } | null;
}

export interface AutoDebitSubscription extends Subscription {
  collection_method: string;
  mandate?: string | null;
}

/** The merchant share of one period (billing §7.1, `vaultSplit`). */
export const expectedShare = (amount: string, feeBps: number) => (BigInt(amount) * BigInt(10_000 - feeBps)) / 10_000n;

/**
 * A customer on an `auto_debit` monthly subscription without tax. `usdCents` prices in USD (paid at par in USDC);
 * `assetAmount` prices in USDC on NEAR base units (1:1), which picks the stand-in scenario by its last two digits.
 */
export async function autoDebitSubscription(
  tag: string,
  price: { usdCents: number } | { assetAmount: string },
): Promise<{ sub: AutoDebitSubscription; email: string; customer: string; price: string }> {
  const cat = await catalogue(tag, "usdCents" in price ? { unitAmount: price.usdCents } : {});
  const priceId =
    "usdCents" in price
      ? cat.monthly
      : (
          await api<{ id: string }>(createPrice, {
            body: {
              product: cat.product,
              unit_amount: price.assetAmount,
              currency: "asset",
              asset_id: USDC_NEAR,
              recurring: { interval: "month" },
              metadata: { testbed: tag },
            },
          })
        ).id;
  const sub = await api<AutoDebitSubscription>(createSubscription, {
    body: {
      customer: cat.customer,
      items: [{ price: priceId }],
      collection_method: "auto_debit",
      days_until_due: 7,
      metadata: { testbed: tag },
    },
  });
  return { sub, email: cat.email, customer: cat.customer, price: priceId };
}

export const getMd = (id: string) => api<Mandate>(getMandate, { params: { id } });
export const mandateUntil = (id: string, done: (m: Mandate) => boolean, what: string, ms = 120_000) =>
  until(() => getMd(id), done, ms, `${id} ${what}`);
export const mandatesOf = (subscription: string) =>
  api<{ data: Mandate[] }>(listMandates, { query: { subscription, limit: "10" } }).then((l) => l.data);
export const getSub = (id: string) => api<AutoDebitSubscription>(getSubscription, { params: { id } });

/** The simulated payer funds `periods` periods for the subscription (billing prepare → stand-in). */
export const fundMandate = (subscription: string, periods: number) =>
  api<MandateSimulation>(simulateMandateFunding, { body: { subscription, periods } });

/** The simulated payer's `top_up` / `cancel` / `withdraw` on the stand-in. */
export const payerAction = (id: string, action: "top_up" | "cancel" | "withdraw", periods?: number) =>
  api<MandateSimulation>(simulateMandatePayerAction, {
    params: { id },
    body: { action, ...(periods ? { periods } : {}) },
  });

/** The mandate the forwarded `mandate_created` produced for the subscription. */
export async function mandateFor(subscription: string, ms = 120_000): Promise<Mandate> {
  const list = await until(
    () => mandatesOf(subscription),
    (l) => l.length > 0,
    ms,
    `mandate of ${subscription}`,
  );
  return list[0] as Mandate;
}

/** Vault event names (`EVENT_JSON:{"standard":"nearpay_vault",…}`, spec `parseVaultEventLog`) in a simulation's logs. */
export const vaultEvents = (logs: readonly string[]): string[] =>
  logs.flatMap((line) => {
    const e = parseVaultEventLog(line);
    return e ? [e.event] : [];
  });

/** A signature-verified webhook at merchant-demo for `object` (optionally matching its data object). */
export const webhook = (type: string, object: string, match?: (o: Record<string, unknown>) => boolean, ms?: number) =>
  md().waitForEvent(
    { type, object, ...(match ? { match: (e) => match(e.event.data.object) } : {}) },
    ms ?? WEBHOOK_TIMEOUT_MS,
  );

/** The account's simulated NEAR Intents balance of `assetId` (sandbox ops `intents-balance`). */
export function intentsBalance(account: string, assetId: string = USDC_NEAR): bigint {
  const r = ops("sandbox-api", ["intents-balance", account, assetId]);
  const balance = (r.json as { balance?: string } | undefined)?.balance;
  if (r.code !== 0 || balance === undefined) throw new Error(`intents-balance ${account}: ${r.stderr || r.stdout}`);
  return BigInt(balance);
}
