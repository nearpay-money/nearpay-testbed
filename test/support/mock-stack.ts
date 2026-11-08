/**
 * A mock NearPay stack for mock-backed tests (step 1.3; the real stack runs in 1.4): one HTTP server
 * implementing the public routes the demos and E2E suites call — merchant sessions, payer routes,
 * sentinel co-signing (test-vector key), agent checkout payments and the x402 facilitator — plus
 * webhook delivery (NearPay-Signature v1) to merchant-demo. Every response is validated with the
 * spec route's response schema, so drift between this mock and the contract fails tests.
 * Test mode only; sandbox scenario 00 (exact payment) only.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type AnyRoute,
  agentPay,
  agentPayRequirements,
  createCheckoutSession,
  createDepositInstructionsAttestation,
  createPaymentAttempt,
  formatSignatureHeader,
  getCheckoutSession,
  getPublicCheckoutSession,
  ID_ALPHABET,
  listPaymentOptions,
  signedPayload,
  simulateDeposit,
  submitSignedIntent,
  x402Requirements,
  x402Settle,
  x402Verify,
} from "@nearpay/spec";
import { verifySigned } from "@nearpay-internal/intents";
import { ed25519 } from "@noble/curves/ed25519.js";
import canonicalize from "canonicalize";

export const SECRET_KEY = "sk_test_mockstack00000000000000000000";
export const WEBHOOK_SECRET = "whsec_mockstack000000000000000000000000001";
export const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
/** The sentinel test-vector key (nearpay-spec/test-vectors/sentinel-attestation.json). */
export const SENTINEL_KEY = { kid: "sent-test-1", public_key: "LHE3Fv7ETKuSmfJWAEBI9iPLlmY5mnePtHvXygDK9GA" };
const SENTINEL_SEED = Buffer.from("61e0b1dbd70fa10f50b34184f3e7400a8885845481d0519d0ae9535665c4d3e9", "hex");
const SD = "sd_01jbz9k3m4n5p6q7r8s9t0v1w2";
const PAY_TO = "merchant-demo.near";
const FINGERPRINT = "YZMN-R81Z-BR";

let counter = 0;
/** A valid TypeID-shaped id (unique per process). */
export function mockId(prefix: string): string {
  let n = BigInt(Date.now()) * 1_000_000n + BigInt(counter++);
  let s = "";
  for (let i = 0; i < 25; i++) {
    s = ID_ALPHABET[Number(n & 31n)] + s;
    n >>= 5n;
  }
  return `${prefix}_0${s}`;
}

const nowS = () => Math.floor(Date.now() / 1000);
const iso = (ms: number) => new Date(ms).toISOString();

interface Attempt {
  id: string;
  method: "route_quote" | "intents_transfer";
  status: string;
  originAsset: string;
  deposit: {
    address: string;
    memo: null;
    amount_in: string;
    min_amount_in: string;
    deadline: string;
    chain: string;
    origin_asset_id: string;
  } | null;
  requirement: {
    pay_to: string;
    token: string;
    amount: string;
    fee_to: string;
    fee_amount: string;
    binding: string;
    deadline: string;
  } | null;
  ticket: string;
  created: number;
}

interface Session {
  id: string;
  secret: string;
  intentId: string;
  amount: number;
  created: number;
  expiresAt: number;
  successUrl: string;
  cancelUrl: string | null;
  description: string | null;
  metadata: Record<string, string>;
  status: "open" | "complete";
  intentStatus: "requires_payment" | "succeeded";
  settled: string;
  succeededAt: number | null;
  attempts: Attempt[];
  sequence: number;
}

interface Issued {
  req: Record<string, unknown> & {
    extra: { binding: string; fee: { to: string; amount: string } };
    amount: string;
    asset: string;
    payTo: string;
  };
  resourceUrl: string;
  expiresAt: number;
  consumed: boolean;
}

export interface MockStack {
  url: string;
  payUrl: string;
  /** Where webhooks go (merchant-demo `/webhooks`). */
  setWebhookUrl(url: string): void;
  sessions: Map<string, Session>;
  calls: string[];
  close(): Promise<void>;
}

function binding(seed: string): string {
  const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt(`0x${createHash("sha256").update(seed).digest("hex")}`);
  let s = "";
  while (n > 0n) {
    s = ALPHA[Number(n % 58n)] + s;
    n /= 58n;
  }
  return `np1:${s.padStart(43, "1")}`;
}

export async function startMockStack(o: { payUrl?: string } = {}): Promise<MockStack> {
  const sessions = new Map<string, Session>();
  const issued = new Map<string, Issued>();
  const settledPayloads = new Map<string, string>();
  const calls: string[] = [];
  let webhookUrl: string | null = null;
  let payUrl = o.payUrl ?? "";

  const deliver = async (type: string, object: Record<string, unknown>) => {
    if (!webhookUrl) return;
    const body = JSON.stringify({
      id: mockId("evt"),
      object: "event",
      type,
      api_version: "2026-11-01",
      created: nowS(),
      livemode: false,
      data: { object },
      request: { id: null, idempotency_key: null },
    });
    const t = nowS();
    const v1 = createHmac("sha256", Buffer.from(WEBHOOK_SECRET)).update(signedPayload(t, body)).digest("hex");
    await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "NearPay-Signature": formatSignatureHeader({ timestamp: t, v1: [v1] }),
      },
      body,
    }).catch(() => {});
  };

  const attemptSummary = (a: Attempt, s: Session) => ({
    id: a.id,
    object: "payment_attempt",
    created: a.created,
    status: a.status,
    method: a.method,
    origin_asset_id: a.originAsset,
    origin_chain: a.method === "route_quote" ? "eip155:8453" : "near:mainnet",
    settlement_amount: String(s.amount * 10_000),
    settled_amount: a.status === "succeeded" ? s.settled : null,
    deadline: a.deposit ? Math.floor(Date.parse(a.deposit.deadline) / 1000) : null,
    is_overpayment: false,
    failure_code: null,
    evidence: null,
  });
  const intentView = (s: Session) => ({
    id: s.intentId,
    object: "payment_intent",
    created: s.created,
    livemode: false,
    status: s.intentStatus,
    amount: s.amount,
    currency: "usd",
    asset_id: null,
    description: s.description,
    source: "checkout",
    checkout_session: s.id,
    destination: {
      settlement_destination: SD,
      asset_id: USDC,
      type: "intents_account",
      chain: "near:mainnet",
      address: PAY_TO,
    },
    fee: { bearer: "merchant", total_bps: 30 },
    settlement_asset_id: USDC,
    amount_settled: s.settled,
    amount_refunded: "0",
    succeeded_at: s.succeededAt,
    late: false,
    canceled_at: null,
    cancellation_reason: null,
    review_reason: null,
    attempts: s.attempts.map((a) => attemptSummary(a, s)),
    overpayments: [],
    sequence: s.sequence,
    metadata: s.metadata,
  });
  const sessionView = (s: Session, opts: { secrets?: boolean; expand?: boolean } = {}) => ({
    id: s.id,
    object: "checkout_session",
    created: s.created,
    livemode: false,
    status: s.status,
    url: opts.secrets ? `${payUrl}/c/${s.id}#${s.secret}` : null,
    client_secret: opts.secrets ? s.secret : null,
    expires_at: s.expiresAt,
    payment_intent: opts.expand ? intentView(s) : s.intentId,
    amount: s.amount,
    currency: "usd",
    asset_id: null,
    settlement_destination: SD,
    ui_mode: "hosted",
    success_url: s.successUrl,
    cancel_url: s.cancelUrl,
    description: s.description,
    allowed_origins: [],
    late_payments: true,
    locale: null,
    completed_at: s.status === "complete" ? s.succeededAt : null,
    late: false,
    metadata: s.metadata,
  });
  const payerAttempt = (a: Attempt) => ({
    id: a.id,
    object: "payment_attempt",
    livemode: false,
    status: a.status,
    method: a.method,
    visible: true,
    origin_asset_id: a.originAsset,
    deposit: a.deposit,
    intents_requirement: a.requirement,
    attestation_ticket: a.status === "awaiting_deposit" ? a.ticket : null,
    failure_code: null,
    refunded_amount: null,
  });
  const publicView = (s: Session) => ({
    id: s.id,
    object: "checkout_session",
    livemode: false,
    status: s.status,
    payment_intent: s.intentId, // spec 0.2.0
    intent_status: s.intentStatus,
    amount: s.amount,
    currency: "usd",
    asset_id: null,
    display: { merchant_name_unverified: "Demo Shop", description: s.description },
    expires_at: iso(s.expiresAt * 1000),
    settlement: { asset_id: USDC, chain: "near:mainnet", type: "intents_account" },
    ui_mode: "hosted",
    allowed_origins: [],
    success_url: s.successUrl,
    cancel_url: s.cancelUrl,
    attempt: s.attempts.length ? payerAttempt(s.attempts[s.attempts.length - 1] as Attempt) : null,
  });

  const succeed = async (s: Session, a: Attempt) => {
    a.status = "succeeded";
    s.intentStatus = "succeeded";
    s.status = "complete";
    s.settled = String(s.amount * 10_000);
    s.succeededAt = nowS();
    s.sequence += 1;
    await deliver("payment_intent.succeeded", intentView(s));
    await deliver("checkout.session.completed", sessionView(s));
  };

  const errorBody = (status: number, code: string) => ({
    error: {
      type: status >= 500 ? "api_error" : status === 401 ? "authentication_error" : "invalid_request_error",
      code,
      message: code,
      doc_url: `https://docs.nearpay.money/errors/${code}`,
      request_id: "req_01jbz9k3m4n5p6q7r8s9t0v1w2",
    },
  });

  async function handle(req: IncomingMessage, raw: string): Promise<[number, unknown]> {
    const url = new URL(req.url ?? "/", "http://mock");
    const method = req.method ?? "GET";
    const path = url.pathname;
    calls.push(`${method} ${path}`);
    const body = raw ? JSON.parse(raw) : undefined;
    const bearer = req.headers.authorization === `Bearer ${SECRET_KEY}`;
    const ok = (route: AnyRoute, value: unknown): [number, unknown] => [
      route.status,
      route.response ? route.response.parse(value) : null,
    ];
    const parse = (route: AnyRoute) =>
      (route.body ? route.body.parse(body ?? {}) : undefined) as Record<string, unknown>;
    const sessionGet = /^\/v1\/checkout\/sessions\/(cs_[0-9a-z]{26})$/.exec(path);
    const sessionSub = /^\/v1\/checkout\/sessions\/(cs_[0-9a-z]{26})\/(public|agent_pay)(.*)$/.exec(path);

    if (method === "POST" && path === "/v1/checkout/sessions") {
      if (!bearer) return [401, errorBody(401, "authentication_required")];
      const b = parse(createCheckoutSession) as {
        amount: number;
        success_url: string;
        cancel_url?: string;
        description?: string;
        metadata?: Record<string, string>;
      };
      const id = mockId("cs");
      const s: Session = {
        id,
        secret: `${id}_secret_${randomBytes(24).toString("base64url").replace(/[-_]/g, "x").slice(0, 32)}`,
        intentId: mockId("pi"),
        amount: b.amount,
        created: nowS(),
        expiresAt: nowS() + 3600,
        successUrl: b.success_url,
        cancelUrl: b.cancel_url ?? null,
        description: b.description ?? null,
        metadata: b.metadata ?? {},
        status: "open",
        intentStatus: "requires_payment",
        settled: "0",
        succeededAt: null,
        attempts: [],
        sequence: 0,
      };
      sessions.set(id, s);
      return ok(createCheckoutSession, sessionView(s, { secrets: true }));
    }
    if (method === "GET" && sessionGet) {
      const m = sessionGet;
      if (!bearer) return [401, errorBody(401, "authentication_required")];
      const s = sessions.get(m[1] as string);
      if (!s) return [404, errorBody(404, "resource_missing")];
      return ok(
        getCheckoutSession,
        sessionView(s, { expand: url.searchParams.getAll("expand[]").includes("payment_intent") }),
      );
    }
    if (sessionSub) {
      const m = sessionSub;
      const s = sessions.get(m[1] as string);
      if (!s || req.headers["x-nearpay-client-secret"] !== s.secret)
        return [401, errorBody(401, "client_secret_invalid")];
      const rest = `${m[2]}${m[3]}`;
      if (method === "GET" && rest === "public") return ok(getPublicCheckoutSession, publicView(s));
      if (method === "GET" && rest === "public/payment_options") {
        const option = (method_: string, asset: string, chain: string) => ({
          method: method_,
          origin_asset_id: asset,
          chain,
          symbol: "USDC",
          decimals: 6,
          estimated_amount_in: String(s.amount * 10_000 + 5013),
          route_class: method_ === "intents_transfer" ? "intents_transfer" : "stable_pair",
          min_deadline_s: 300,
          available: true,
          reason: null,
        });
        return ok(listPaymentOptions, {
          object: "payment_options",
          options: [option("route_quote", USDC_BASE, "eip155:8453"), option("intents_transfer", USDC, "near:mainnet")],
        });
      }
      if (s.status !== "open" && method === "POST" && !rest.includes("simulate"))
        return [409, errorBody(409, "session_not_open")];
      const newIntentsAttempt = () => {
        const a: Attempt = {
          id: mockId("pa"),
          method: "intents_transfer",
          status: "awaiting_deposit",
          originAsset: USDC,
          deposit: null,
          requirement: {
            pay_to: PAY_TO,
            token: USDC,
            amount: String(s.amount * 10_000),
            fee_to: "treasury.nearpay.near",
            fee_amount: String(s.amount * 30),
            binding: binding(`${s.id}:${s.attempts.length}`),
            deadline: iso(Date.now() + 120_000),
          },
          ticket: `${Buffer.from(`t:${s.id}`).toString("base64url")}.c2ln`,
          created: nowS(),
        };
        s.attempts.push(a);
        return a;
      };
      if (method === "POST" && rest === "public/attempts") {
        const b = parse(createPaymentAttempt) as { method: string; origin_asset_id: string };
        if (b.method === "intents_transfer") return ok(createPaymentAttempt, payerAttempt(newIntentsAttempt()));
        const a: Attempt = {
          id: mockId("pa"),
          method: "route_quote",
          status: "awaiting_deposit",
          originAsset: b.origin_asset_id,
          deposit: {
            address: `0x${createHash("sha256").update(s.id).digest("hex").slice(0, 40)}`,
            memo: null,
            amount_in: String(s.amount * 10_000 + 5013),
            min_amount_in: String(s.amount * 10_000),
            deadline: iso(Date.now() + 900_000),
            chain: "eip155:8453",
            origin_asset_id: b.origin_asset_id,
          },
          requirement: null,
          ticket: `${Buffer.from(`t:${s.id}`).toString("base64url")}.c2ln`,
          created: nowS(),
        };
        s.attempts.push(a);
        return ok(createPaymentAttempt, payerAttempt(a));
      }
      const am = /^public\/attempts\/(pa_[0-9a-z]{26})\/(simulate_deposit|signed_intent)$/.exec(rest);
      if (method === "POST" && am) {
        const a = s.attempts.find((x) => x.id === am[1]);
        if (!a) return [404, errorBody(404, "resource_missing")];
        if (am[2] === "simulate_deposit") {
          parse(simulateDeposit);
          await succeed(s, a);
          return ok(simulateDeposit, null);
        }
        const { signed } = parse(submitSignedIntent) as { signed: unknown };
        if (!verifySigned(signed).ok) return [400, errorBody(400, "intent_invalid")];
        await succeed(s, a);
        return ok(submitSignedIntent, null);
      }
      if (method === "POST" && rest === "agent_pay/requirements") {
        parse(agentPayRequirements);
        const a = newIntentsAttempt();
        return ok(agentPayRequirements, {
          object: "agent_pay_requirements",
          livemode: false,
          attempt_id: a.id,
          attestation_ticket: a.ticket,
          requirement: a.requirement,
        });
      }
      if (method === "POST" && rest === "agent_pay") {
        const { signed } = parse(agentPay) as { signed: unknown };
        const v = verifySigned(signed);
        const a = s.attempts.at(-1);
        if (!v.ok || !a?.requirement) return [400, errorBody(400, "intent_invalid")];
        if (
          canonicalize(v.message.intents.map((i) => (i as { receiver_id: string }).receiver_id)) !==
          canonicalize([a.requirement.pay_to, a.requirement.fee_to])
        ) {
          return [400, errorBody(400, "intent_invalid")];
        }
        await succeed(s, a);
        return ok(agentPay, {
          object: "agent_pay_submission",
          status: "submitted",
          agent_payment: mockId("ap"),
          attempt: payerAttempt(a),
        });
      }
      return [404, errorBody(404, "resource_missing")];
    }
    if (method === "POST" && path === "/v1/attestations/deposit_instructions") {
      const b = parse(createDepositInstructionsAttestation) as {
        kind: string;
        attempt_id: string;
        attestation_ticket: string;
        livemode: boolean;
        deposit?: Attempt["deposit"];
        requirement?: Attempt["requirement"];
      };
      const a = [...sessions.values()].flatMap((s) => s.attempts).find((x) => x.id === b.attempt_id);
      if (!a || a.ticket !== b.attestation_ticket) return [401, errorBody(401, "ticket_invalid")];
      // Sentinel re-reads the truth (here: the stored attempt), never the request.
      const attestation = {
        v: 1,
        kind: a.method,
        attempt_id: a.id,
        livemode: false,
        ...(a.deposit
          ? {
              deposit: {
                address: a.deposit.address,
                memo: a.deposit.memo,
                chain: a.deposit.chain,
                origin_asset_id: a.deposit.origin_asset_id,
                amount_in: a.deposit.amount_in,
                deadline: a.deposit.deadline,
              },
            }
          : {}),
        ...(a.requirement ? { requirement: a.requirement } : {}),
        merchant: { name: "Demo Shop", kyb_verified: false },
        destination: { asset_id: USDC, chain: "near:mainnet", fingerprint: FINGERPRINT },
        issued_at: iso(Date.now()),
        expires_at: a.deposit?.deadline ?? a.requirement?.deadline,
      };
      const sig = ed25519.sign(new TextEncoder().encode(canonicalize(attestation) as string), SENTINEL_SEED);
      return ok(createDepositInstructionsAttestation, {
        attestation,
        kid: SENTINEL_KEY.kid,
        signature: Buffer.from(sig).toString("base64url"),
      });
    }
    if (path.startsWith("/x402/")) {
      if (!bearer) return [401, errorBody(401, "authentication_required")];
      if (path === "/x402/requirements") {
        const b = parse(x402Requirements) as {
          resource: { url: string; description?: string; mimeType?: string };
          amount: string;
          asset_id?: string;
          max_timeout_s?: number;
        };
        const window = b.max_timeout_s ?? 120;
        const bind = binding(`${b.resource.url}:${randomBytes(8).toString("hex")}`);
        const req = {
          scheme: "exact",
          network: "near:mainnet",
          amount: b.amount,
          asset: b.asset_id ?? USDC,
          payTo: PAY_TO,
          maxTimeoutSeconds: window,
          extra: {
            assetTransferMethod: "intents-transfer",
            paymentFlow: "authorization",
            fee: { to: "treasury.nearpay.near", amount: String((BigInt(b.amount) * 30n + 9999n) / 10000n) },
            binding: bind,
            verifyingContract: "intents.near",
          },
        };
        issued.set(bind, { req, resourceUrl: b.resource.url, expiresAt: Date.now() + window * 1000, consumed: false });
        return ok(x402Requirements, { x402Version: 2, resource: b.resource, accepts: [req] });
      }
      const b = parse(path === "/x402/verify" ? x402Verify : x402Settle) as {
        paymentPayload: { payload: { signed: unknown }; accepted: unknown; resource?: { url: string } };
        paymentRequirements: Issued["req"];
      };
      const item = issued.get(b.paymentRequirements.extra.binding);
      const v = verifySigned(b.paymentPayload.payload.signed);
      const reason = !item
        ? "requirement_unknown"
        : canonicalize(item.req) !== canonicalize(b.paymentRequirements) ||
            canonicalize(b.paymentPayload.accepted) !== canonicalize(item.req)
          ? "invalid_payment_requirements"
          : b.paymentPayload.resource && b.paymentPayload.resource.url !== item.resourceUrl
            ? "invalid_payment_requirements"
            : !v.ok
              ? v.reason
              : null;
      const payer = v.ok ? v.message.signer_id : undefined;
      const hash = createHash("sha256")
        .update(canonicalize(b.paymentPayload.payload.signed) as string)
        .digest("hex");
      if (path === "/x402/verify") {
        return ok(
          x402Verify,
          reason
            ? { isValid: false, invalidReason: reason }
            : item?.consumed && !settledPayloads.has(hash)
              ? { isValid: false, invalidReason: "requirement_consumed" }
              : { isValid: true, payer },
        );
      }
      if (reason || !item)
        return ok(x402Settle, { success: false, transaction: "", network: "near:mainnet", errorReason: reason });
      const done = settledPayloads.get(hash);
      if (done)
        return ok(x402Settle, {
          success: true,
          transaction: done,
          network: "near:mainnet",
          payer,
          amount: item.req.amount,
        });
      if (item.consumed)
        return ok(x402Settle, {
          success: false,
          transaction: "",
          network: "near:mainnet",
          errorReason: "requirement_consumed",
        });
      item.consumed = true;
      const tx = binding(hash).slice(4);
      settledPayloads.set(hash, tx);
      await deliver("agent_payment.settled", {
        id: mockId("ap"),
        object: "agent_payment",
        created: nowS(),
        livemode: false,
        kind: "x402",
        status: "settled",
        payer,
        pay_to: item.req.payTo,
        asset_id: item.req.asset,
        amount: item.req.amount,
        fee_amount: item.req.extra.fee.amount,
        binding: item.req.extra.binding,
        resource_url: item.resourceUrl,
        checkout_session: null,
        tx_hash: tx,
        block_height: 1,
        error_reason: null,
        settled_at: nowS(),
      });
      return ok(x402Settle, {
        success: true,
        transaction: tx,
        network: "near:mainnet",
        payer,
        amount: item.req.amount,
      });
    }
    return [404, errorBody(404, "resource_missing")];
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      handle(req, raw)
        .then(([status, body]) => {
          res.writeHead(status, body === null ? {} : { "content-type": "application/json" });
          res.end(body === null ? undefined : JSON.stringify(body));
        })
        .catch((e: Error) => {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ mock_error: e.message }));
        });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  payUrl ||= "https://pay.mock.test"; // only parsed by payers (they call the API at `url`)
  return {
    url,
    payUrl,
    setWebhookUrl: (u) => {
      webhookUrl = u;
    },
    sessions,
    calls,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Starts merchant-demo (in process) wired to a mock stack: secrets via env, webhooks delivered to it. */
export async function startMerchantDemo(stack: MockStack, over: Record<string, string> = {}) {
  const { createApp } = await import("../../merchant-demo/src/app.js");
  const { readConfig } = await import("../../merchant-demo/src/config.js");
  const config = readConfig({
    NP_ENV: "test",
    NP_PUBLIC_API_URL: stack.url,
    NP_DEMO_SECRET_KEY: SECRET_KEY,
    NP_DEMO_WEBHOOK_SECRET: WEBHOOK_SECRET,
    NP_DEMO_SECRETS_DIR: "/nonexistent",
    NP_DEMO_PUBLIC_URL: "http://placeholder",
    ...over,
  });
  const server = createApp({ config, log: () => {} }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  config.publicUrl = over.NP_DEMO_PUBLIC_URL ?? url;
  stack.setWebhookUrl(`${url}/webhooks`);
  return { url, config, close: () => new Promise<void>((r) => server.close(() => r())) };
}
