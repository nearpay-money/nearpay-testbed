/**
 * Stage 4 scenario 3 — chain coverage on the payer side (development plan §6 step 4.4 "a Solana payer completes a
 * checkout"; lld/checkout-and-js.md §11, lld/sentinel.md §16, lld/rails.md §21, lld/sandbox.md §10): merchant-demo
 * creates a USD 2.00 session and a scripted payer does what the hosted checkout does in test mode.
 *
 * - Solana (USDC SPL, and native SOL): sentinel attests the Solana deposit — `solana:` CAIP-2 chain, a unique 32-byte
 *   base58 deposit address, **no memo**, the attested origin asset (SPL mint / native) that the wallet recipe and the
 *   Solana Pay QR are built from → "Simulate payment" → `payment_intent.succeeded`, order complete; the merchant sees
 *   the attempt from Solana with the payer's Solana refund address (INV-7) and the amount sent.
 * - Bitcoin manual path: BTC is attested with a P2WPKH deposit address and no memo (Bitcoin is never amount-tagged),
 *   the BIP-21 QR carries the exact BTC amount → simulated deposit (1 confirmation below USD 1,000) → succeeded, with
 *   the Bitcoin refund address recorded.
 */
import {
  BITCOIN_MAINNET,
  bip21Uri,
  formatBaseUnits,
  SOLANA_MAINNET,
  simulateDeposit,
  solanaPayUri,
} from "@nearpay-money/spec";
import { describe, expect, it } from "vitest";
import { call } from "../../lib/http.js";
import { base58Decode } from "../../lib/onboard.js";
import { type AttestedAttempt, attestedAttempt, sessionFromUrl } from "../../lib/payer.js";
import { md, payer, realStack, WEBHOOK_TIMEOUT_MS } from "../support/env.js";
import { TEST_REFUND_SOLANA, USDC_SOLANA } from "../support/stage3.js";
import { BTC, SOL_NATIVE, TEST_REFUND_BITCOIN, USDC_SOLANA_MINT } from "../support/stage4.js";

const PAY_MS = 3 * 60_000;

interface OrderAttempt {
  status: string;
  origin_asset_id: string;
  origin_chain: string;
  refund_to?: string | null;
  origin_amount?: string | null;
  evidence: unknown;
}

/** merchant-demo session → attested `route_quote` attempt from `origin` → (checks) → "Simulate payment" → succeeded. */
async function payFrom(
  origin: string,
  refundTo: string,
  check: (a: AttestedAttempt) => void,
  expiresIn?: number,
): Promise<{ attempt: OrderAttempt; attested: AttestedAttempt }> {
  const demo = md();
  const s = await demo.checkout(undefined, expiresIn);
  const c = payer(s.url as string, sessionFromUrl);
  const attested = await attestedAttempt(c, { method: "route_quote", originAssetId: origin, refundTo });
  check(attested);
  await call(simulateDeposit, {
    base: c.apiBase,
    clientSecret: c.clientSecret,
    params: { id: c.sessionId, attempt: attested.attempt.id },
    body: {},
  });
  await demo.waitForEvent({ type: "payment_intent.succeeded", object: s.payment_intent }, PAY_MS);
  await demo.waitForEvent({ type: "checkout.session.completed", object: s.id }, WEBHOOK_TIMEOUT_MS);
  const order = (await demo.order(s.id)) as unknown as {
    status: string;
    payment_intent: { attempts: OrderAttempt[] };
  };
  expect(order.status).toBe("complete");
  const won = order.payment_intent.attempts.find((a) => a.status === "succeeded");
  expect(won?.evidence).toBeTruthy();
  return { attempt: won as OrderAttempt, attested };
}

describe.skipIf(!realStack)("Stage 4 · Solana and Bitcoin payers", () => {
  it("Solana USDC (SPL): attested deposit without memo, Solana Pay QR with the mint → paid", async () => {
    const { attempt, attested } = await payFrom(USDC_SOLANA, TEST_REFUND_SOLANA, (a) => {
      const d = a.attestation.deposit;
      expect(d).toMatchObject({ chain: SOLANA_MAINNET, memo: null, origin_asset_id: USDC_SOLANA });
      expect(base58Decode(d?.address as string)).toHaveLength(32);
      // the wallet recipe (CreateIdempotent ATA + TransferChecked) is built only from the attested SPL mint
      expect(a.attestation.asset).toMatchObject({
        asset_id: USDC_SOLANA,
        decimals: 6,
        token: { standard: "spl", address: USDC_SOLANA_MINT },
      });
      expect(solanaPayUri(d?.address as string, d?.amount_in as string, 6, USDC_SOLANA_MINT)).toBe(
        `solana:${d?.address}?amount=${formatBaseUnits(d?.amount_in as string, 6)}&spl-token=${USDC_SOLANA_MINT}`,
      );
    });
    expect(attempt).toMatchObject({
      origin_asset_id: USDC_SOLANA,
      origin_chain: SOLANA_MAINNET,
      refund_to: TEST_REFUND_SOLANA,
    });
    expect(attempt.origin_amount).toBe(attested.attempt.deposit?.amount_in);
  });

  it("native SOL: attested native asset (System.Transfer recipe) → paid", async () => {
    const { attempt } = await payFrom(SOL_NATIVE, TEST_REFUND_SOLANA, (a) => {
      expect(a.attestation.deposit).toMatchObject({ chain: SOLANA_MAINNET, memo: null, origin_asset_id: SOL_NATIVE });
      expect(a.attestation.asset).toMatchObject({
        asset_id: SOL_NATIVE,
        decimals: 9,
        token: { standard: "native", address: null },
      });
    });
    expect(attempt).toMatchObject({ origin_chain: SOLANA_MAINNET, refund_to: TEST_REFUND_SOLANA });
  });

  it("Bitcoin manual path: P2WPKH deposit, no memo, BIP-21 amount → paid", async () => {
    // Bitcoin's chain profile needs >= 1 h before the deadline (rails chains.yaml min_deadline_s 3600): a default
    // 1-hour session (account session_ttl_default) leaves less than that by the attempt, so it answers route_too_slow;
    // this session gets 2 h (test-mode expires_in override).
    const { attempt, attested } = await payFrom(
      BTC,
      TEST_REFUND_BITCOIN,
      (a) => {
        const d = a.attestation.deposit;
        expect(d).toMatchObject({ chain: BITCOIN_MAINNET, memo: null, origin_asset_id: BTC });
        expect(d?.address).toMatch(/^bc1q[02-9ac-hj-np-z]{38}$/);
        expect(a.attestation.asset).toMatchObject({ asset_id: BTC, decimals: 8 });
        const uri = bip21Uri(d?.address as string, d?.amount_in as string);
        expect(uri).toBe(`bitcoin:${d?.address}?amount=${formatBaseUnits(d?.amount_in as string, 8)}`);
        expect(BigInt(d?.amount_in as string)).toBeGreaterThan(0n);
      },
      7200,
    );
    expect(attempt).toMatchObject({
      origin_asset_id: BTC,
      origin_chain: BITCOIN_MAINNET,
      refund_to: TEST_REFUND_BITCOIN,
    });
    expect(attempt.origin_amount).toBe(attested.attempt.deposit?.amount_in);
  });
});
