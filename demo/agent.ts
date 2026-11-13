/**
 * `pnpm demo:agent` — Stage 1 demo script step 5 (roadmap/development-plan.md §3): an AI agent calls
 * merchant-demo `/premium`, receives `402`, signs a NEAR Intents transfer (`@nearpay-money/agent-signer`
 * via `withX402`), receives the resource with `PAYMENT-RESPONSE`, then `agent_payment.settled`
 * arrives at merchant-demo.
 *
 * Agent key: `NP_AGENT_SECRET_KEY` (`ed25519:…`) or `NP_AGENT_SECRET_KEY_FILE`, account
 * `NP_AGENT_ACCOUNT` (default: the key's implicit account). Without a key, test mode uses the fixed
 * demo agent key below (sandbox only; its sandbox balance must be funded, see README).
 * Options: --live (salt from NEAR RPC, `NP_NEAR_RPC_URLS`), --max <base units> (spend limit on
 * amount + fee, default 100000 = 0.10 USDC), --asset <asset id> (default USDC), --timeout <s>.
 */
import "../lib/localhost-dns.js"; // *.localhost → loopback: glibc without nss-myhostname does not resolve these names
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { type IntentSigner, nearSigner, rpcSaltProvider, staticSaltProvider } from "@nearpay-money/agent-signer";
import { encodeX402Header, HEADERS, type PaymentPayload } from "@nearpay-money/spec";
import { decodePaymentResponse, parsePaymentRequired, withX402 } from "@nearpay-money/x402";
import { merchantDemo } from "../lib/merchant-demo.js";
import { type Stack, stackFromEnv } from "../lib/stack.js";

export const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
/** TEST-ONLY demo agent seed: sha256("nearpay demo agent (test only)"). Never fund it on mainnet. */
export const DEMO_AGENT_SEED_HEX = "ff905b5e245e6b012eb6be5a07fafd6cd779b6b63d5c58bdeb6d15c41d68f4cc";

type Env = Record<string, string | undefined>;

export function agentSigner(env: Env, live: boolean): IntentSigner {
  const key =
    env.NP_AGENT_SECRET_KEY ??
    (env.NP_AGENT_SECRET_KEY_FILE ? readFileSync(env.NP_AGENT_SECRET_KEY_FILE, "utf8").trim() : undefined);
  if (!key) {
    if (live)
      throw new Error(
        "live mode needs NP_AGENT_SECRET_KEY or NP_AGENT_SECRET_KEY_FILE (the funded agent account's key)",
      );
    return nearSigner({ keyPair: Uint8Array.from(Buffer.from(DEMO_AGENT_SEED_HEX, "hex")), standard: "nep413" });
  }
  return nearSigner({ keyPair: key, ...(env.NP_AGENT_ACCOUNT ? { accountId: env.NP_AGENT_ACCOUNT } : {}) });
}

export interface AgentDemoResult {
  payer: string;
  transaction: string;
  elapsedMs: number;
  eventId: string | null;
  header: string;
}

export async function runAgentDemo(
  argv: readonly string[],
  deps: { stack?: Stack; env?: Env; log?: (s: string) => void; fetch?: typeof fetch } = {},
): Promise<AgentDemoResult> {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    options: {
      live: { type: "boolean" },
      max: { type: "string" },
      asset: { type: "string" },
      timeout: { type: "string" },
    },
  });
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((s: string) => process.stdout.write(`${s}\n`));
  const f = deps.fetch ?? fetch;
  const stack = deps.stack ?? stackFromEnv(env);
  const md = merchantDemo(stack.merchantDemoUrl, f);
  const live = values.live ?? false;
  const signer = agentSigner(env, live);
  const asset = values.asset ?? USDC;
  log(`[5] agent ${signer.signerId} (${signer.standard}, ${live ? "LIVE" : "test mode"}) → ${md.premiumUrl}`);

  const plain = await f(md.premiumUrl);
  const required = parsePaymentRequired(plain.headers.get(HEADERS.x402PaymentRequired));
  await plain.body?.cancel();
  const offer = required?.accepts[0];
  if (plain.status !== 402 || !offer) throw new Error(`expected 402 with a NearPay requirement, got ${plain.status}`);
  log(`    402 Payment Required: ${offer.amount} + fee ${offer.extra.fee.amount} of ${offer.asset} to ${offer.payTo}`);

  let paidPayload: PaymentPayload | null = null;
  const pay = withX402(f, signer, {
    maxAmountPerRequest: { [asset]: values.max ?? "100000" },
    nonceSaltProvider: live
      ? rpcSaltProvider(env.NP_NEAR_RPC_URLS ? { rpcUrls: env.NP_NEAR_RPC_URLS.split(",") } : {})
      : staticSaltProvider("00000000"),
    onPayment: ({ payload }) => {
      // No `crossChain` option: the client only pays `intents-transfer`, so this is the spec's PaymentPayload.
      paidPayload = payload as PaymentPayload;
    },
  });
  const t0 = Date.now();
  const res = await pay(md.premiumUrl, { headers: { accept: "application/json" } });
  const elapsedMs = Date.now() - t0;
  const settlement = decodePaymentResponse(res);
  const body = await res.text();
  if (res.status !== 200 || !settlement?.success) {
    throw new Error(
      `payment failed: ${res.status} ${settlement?.errorReason ?? ""} ${settlement?.errorMessage ?? body.slice(0, 200)}`,
    );
  }
  const payload = paidPayload as PaymentPayload | null;
  const header = payload ? encodeX402Header(payload) : "";
  log(
    `    200 in ${(elapsedMs / 1000).toFixed(2)} s; PAYMENT-RESPONSE: tx ${settlement.transaction}, payer ${settlement.payer}`,
  );
  log(`    resource: ${body}`);

  const binding = payload?.accepted.extra.binding;
  let eventId: string | null = null;
  try {
    const event = await md.waitForEvent(
      { type: "agent_payment.settled", match: (e) => e.event.data.object.binding === binding },
      Number(values.timeout ?? 60) * 1000,
    );
    eventId = event.id;
    log(`    agent_payment.settled webhook ${event.id} received (signature verified by merchant-demo)`);
  } catch (e) {
    log(`    no agent_payment.settled webhook yet: ${(e as Error).message}`);
    throw e;
  }
  return { payer: signer.signerId, transaction: settlement.transaction, elapsedMs, eventId, header };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runAgentDemo(process.argv.slice(2)).then(
    () => process.exit(0),
    (e: Error) => {
      process.stderr.write(`demo:agent failed: ${e.message}\n`);
      process.exit(1);
    },
  );
}
