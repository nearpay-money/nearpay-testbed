/**
 * A scripted payer for test mode, doing what the hosted checkout does (checkout LLD §5) through the
 * public payer routes: read the session, pick an option, create an attempt, get sentinel's
 * co-signature and verify it with the pinned key (fail closed, rule 2), then either simulate the
 * deposit (`route_quote`, test helper) or sign and submit the Intents transfer (`intents_transfer`, T3).
 */
import {
  buildTransferPayment,
  type IntentSigner,
  type PinnedSentinelKey,
  type SaltProvider,
  staticSaltProvider,
  verifyAttestation,
} from "@nearpay/agent-signer";
import {
  createDepositInstructionsAttestation,
  createPaymentAttempt,
  getPublicCheckoutSession,
  type IntentsRequirement,
  listPaymentOptions,
  simulateDeposit,
  submitSignedIntent,
  type z,
} from "@nearpay/spec";
import { ApiError, call } from "./http.js";

/** Cloudflare's always-pass test token: the local stack uses the always-pass test secret. */
export const TURNSTILE_TEST_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
/** USDC on Base (the demo payer's asset, demo script step 3). */
export const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
/** A refund address on Base for scripted payers (test mode only). */
export const TEST_REFUND_EVM = "0x000000000000000000000000000000000000dEaD";

type PublicSession = z.output<typeof getPublicCheckoutSession.response & object>;
type PayerAttempt = z.output<typeof createPaymentAttempt.response & object>;

export interface PayerContext {
  apiBase: string;
  sessionId: string;
  clientSecret: string;
  pinnedKeys: readonly PinnedSentinelKey[];
  fetch?: typeof fetch;
  now?: () => number;
  /** Backoff between attestation retries (tests inject a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

/** Tries for `503 attestation_unavailable` (sentinel's fail-closed answer while a dependency is slow). */
export const ATTESTATION_TRIES = 4;

/**
 * Asks sentinel again while it answers `503 attestation_unavailable` ("try again shortly"; the hosted
 * checkout offers the same retry from `verify_failed`, checkout LLD §5). Every other answer, including
 * refusals (`409 attestation_refused`, `401 ticket_invalid`), is final, and whatever comes back is
 * still verified against the pinned key: the retry never relaxes the co-signature check.
 */
export async function retryUnavailable<T>(
  attest: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await attest();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "attestation_unavailable") || i >= ATTESTATION_TRIES) throw e;
      await sleep(1000 * i);
    }
  }
}

export interface AttestedAttempt {
  session: PublicSession;
  attempt: PayerAttempt;
  merchant: { name: string; kyb_verified: boolean };
  fingerprint: string;
}

/** Splits `https://pay…/c/cs_…#cs_…_secret_…` into session id and client secret. */
export function sessionFromUrl(url: string): { sessionId: string; clientSecret: string } {
  const u = new URL(url);
  const m = /\/(?:c|embed)\/(cs_[0-9a-z]{26})$/.exec(u.pathname);
  const secret = decodeURIComponent(u.hash.slice(1));
  if (!m || !secret.startsWith(`${m[1]}_secret_`)) throw new Error(`not a checkout URL with a client secret: ${url}`);
  return { sessionId: m[1] as string, clientSecret: secret };
}

const base = (c: PayerContext) => ({
  base: c.apiBase,
  params: { id: c.sessionId },
  clientSecret: c.clientSecret,
  ...(c.fetch ? { fetch: c.fetch } : {}),
});

/** Creates an attempt and releases it only after sentinel's co-signature verifies (throws otherwise). */
export async function attestedAttempt(
  c: PayerContext,
  choice:
    | { method: "route_quote"; originAssetId: string; refundTo: string }
    | { method: "intents_transfer"; originAssetId: string; payerWallet: string },
): Promise<AttestedAttempt> {
  const session = await call<PublicSession>(getPublicCheckoutSession, base(c));
  const options = await call<{ options: { method: string; origin_asset_id: string }[] }>(listPaymentOptions, base(c));
  if (!options.options.some((o) => o.method === choice.method && o.origin_asset_id === choice.originAssetId)) {
    throw new Error(`payment option ${choice.method} ${choice.originAssetId} is not offered`);
  }
  const attempt = await call<PayerAttempt>(createPaymentAttempt, {
    ...base(c),
    body: {
      method: choice.method,
      origin_asset_id: choice.originAssetId,
      ...(choice.method === "route_quote" ? { refund_to: choice.refundTo } : { payer_wallet: choice.payerWallet }),
      turnstile_token: TURNSTILE_TEST_TOKEN,
    },
  });
  if (!attempt.attestation_ticket)
    throw new Error(`attempt ${attempt.id} has no attestation ticket (${attempt.status})`);
  const request =
    attempt.method === "route_quote"
      ? (() => {
          const d = attempt.deposit;
          if (!d) throw new Error(`route_quote attempt ${attempt.id} has no deposit instructions`);
          const deposit = {
            address: d.address,
            memo: d.memo,
            chain: d.chain,
            origin_asset_id: d.origin_asset_id,
            amount_in: d.amount_in,
            deadline: d.deadline,
          };
          return {
            expected: { kind: "route_quote" as const, attemptId: attempt.id, livemode: attempt.livemode, deposit },
            body: { deposit },
          };
        })()
      : (() => {
          const requirement = attempt.intents_requirement as IntentsRequirement | null;
          if (!requirement) throw new Error(`intents_transfer attempt ${attempt.id} has no requirement`);
          return {
            expected: {
              kind: "intents_transfer" as const,
              attemptId: attempt.id,
              livemode: attempt.livemode,
              requirement,
            },
            body: { requirement },
          };
        })();
  const attest = () =>
    call<unknown>(createDepositInstructionsAttestation, {
      base: c.apiBase,
      ...(c.fetch ? { fetch: c.fetch } : {}),
      body: {
        livemode: attempt.livemode,
        kind: attempt.method,
        attempt_id: attempt.id,
        attestation_ticket: attempt.attestation_ticket,
        ...request.body,
      },
    });
  const signed = await retryUnavailable(attest, c.sleep);
  const check = verifyAttestation(signed, request.expected, { pinnedKeys: c.pinnedKeys, now: (c.now ?? Date.now)() });
  if (!check.ok) throw new Error(`sentinel co-signature refused: ${check.reason} (${check.detail})`);
  return {
    session,
    attempt,
    merchant: check.attestation.merchant,
    fingerprint: check.attestation.destination.fingerprint,
  };
}

/** Test mode, manual/wallet path: attested `route_quote` attempt, then "Simulate payment". */
export async function payBySimulatedDeposit(
  c: PayerContext,
  o: { originAssetId?: string; refundTo?: string; amountIn?: string } = {},
): Promise<AttestedAttempt> {
  const r = await attestedAttempt(c, {
    method: "route_quote",
    originAssetId: o.originAssetId ?? USDC_BASE,
    refundTo: o.refundTo ?? TEST_REFUND_EVM,
  });
  await call(simulateDeposit, {
    ...base(c),
    params: { id: c.sessionId, attempt: r.attempt.id },
    body: o.amountIn ? { amount_in: o.amountIn } : {},
  });
  return r;
}

/** Human Intents-balance path (T3): attested `intents_transfer` attempt, sign, submit. */
export async function payFromIntentsBalance(
  c: PayerContext,
  signer: IntentSigner,
  o: { originAssetId: string; nonceSaltProvider?: SaltProvider },
): Promise<AttestedAttempt> {
  const r = await attestedAttempt(c, {
    method: "intents_transfer",
    originAssetId: o.originAssetId,
    payerWallet: signer.signerId,
  });
  const signed = await buildTransferPayment(r.attempt.intents_requirement as IntentsRequirement, signer, {
    nonceSaltProvider: o.nonceSaltProvider ?? staticSaltProvider("00000000"),
  });
  await call(submitSignedIntent, { ...base(c), params: { id: c.sessionId, attempt: r.attempt.id }, body: { signed } });
  return r;
}
