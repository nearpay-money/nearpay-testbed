/**
 * Refund signing for E2E (payments §8.4, dashboard §1 "Refund signing"): checks a `sign_intent` next action is
 * self-consistent the way the dashboard does before any signature, then signs `nep413` verbatim with the
 * merchant's Intents-account key → `submit_tx {signed_intent}` (relayed by agentpay).
 *
 * The demo merchant (`seed.sh data`) settles to the named test account `merchant-demo.near`; the sandbox
 * Verifier registers the first key that signs for a named account (its stand-in for `add_public_key`), so the
 * testbed signs with one fixed test-only key. Never use it outside a local test-mode stack.
 */
import { createHash } from "node:crypto";
import { nep413Hash } from "@nearpay-money/agent-signer";
import type { MultiPayload } from "@nearpay-money/spec";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58Encode } from "./onboard.js";

/** sha256("nearpay merchant-demo.near (test only)") — the demo merchant's sandbox Intents key. */
export const DEMO_MERCHANT_SEED = createHash("sha256").update("nearpay merchant-demo.near (test only)").digest();
export const DEMO_MERCHANT_ACCOUNT = "merchant-demo.near";

export interface SignIntentAction {
  type: "sign_intent";
  signer_id: string;
  transfer: { receiver_id: string; token: string; amount: string; memo?: string | null };
  nep413: { recipient: string; nonce: string; message: string };
  payload?: unknown;
}

/** The dashboard's pre-signing checks (one transfer equal to `transfer`, signer, deadline, amount). */
export function checkSignIntent(a: SignIntentAction, refund: { asset_id: string }, nowMs = Date.now()): void {
  const m = JSON.parse(a.nep413.message) as {
    signer_id: string;
    deadline: string;
    intents: { intent: string; receiver_id: string; tokens: Record<string, string>; memo?: string }[];
  };
  const fail = (why: string) => {
    throw new Error(`refusing to sign the refund action: ${why}`);
  };
  if (m.signer_id !== a.signer_id) fail("signer differs");
  if (Date.parse(m.deadline) <= nowMs) fail("deadline passed");
  if (a.transfer.token !== refund.asset_id) fail("asset differs from the refund asset");
  if (!(BigInt(a.transfer.amount) > 0n)) fail("amount is not positive");
  if (m.intents.length !== 1 || m.intents[0]?.intent !== "transfer") fail("not exactly one transfer intent");
  const t = m.intents[0] as (typeof m.intents)[number];
  if (t.receiver_id !== a.transfer.receiver_id) fail("receiver differs");
  if (Object.keys(t.tokens).length !== 1 || t.tokens[a.transfer.token] !== a.transfer.amount) fail("tokens differ");
  if ((t.memo ?? null) !== (a.transfer.memo ?? null)) fail("memo differs");
}

/** Signs the issued NEP-413 message verbatim with an ed25519 seed. */
export function signNep413Intent(a: SignIntentAction, seed: Uint8Array): MultiPayload {
  const hash = nep413Hash(a.nep413.message, Uint8Array.from(Buffer.from(a.nep413.nonce, "base64")), a.nep413.recipient);
  const pub = ed25519.getPublicKey(seed);
  return {
    standard: "nep413",
    payload: { recipient: a.nep413.recipient, nonce: a.nep413.nonce, message: a.nep413.message },
    public_key: `ed25519:${base58Encode(pub)}`,
    signature: `ed25519:${base58Encode(ed25519.sign(hash, seed))}`,
  } as MultiPayload;
}
