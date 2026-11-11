/**
 * Stage 3 scenario 5 (+6) — agent commerce in the sandbox (development plan §5 step 3.4 "an MCP-driven agent pays a
 * checkout session and a cross-chain x402 resource"; lld/agentpay.md §3.1, lld/sdks-and-tools.md §2):
 *
 * a) `@nearpay-money/x402` cross-chain: a merchant route behind `withPaywall({origins: [Base USDC]})` (demo merchant key,
 *    facilitator = the real stack) and an agent `withX402(..., {crossChain})` → 402 → quote (rails route_quote via the
 *    sandbox 1Click) → deposit → settle once rails holds evidence → 200 + `PAYMENT-RESPONSE` → `agent_payment.settled`
 *    (`transfer_method: near-intents`). The test-mode origin signer only reports a deposit tx: the sandbox 1Click
 *    records the deposit when rails submits it (`/v0/deposit/submit`), there is no origin chain to broadcast to.
 *    A failing scenario (amount ending 04) is refused and creates no agent payment (AgentPayment only on `settled`).
 * b) `@nearpay-money/mcp` (stdio binary, payer tools from the demo agent's sandbox Intents balance): pays a checkout session
 *    and a hosted invoice (`/i/<id>#<secret>`), within the budget and only to the allow-listed merchant; refusals for
 *    a lowered limit and for a merchant that is not on the allow-list.
 * c) the same MCP server embedded with the test-mode origin signer: `nearpay_fetch_paid` pays the cross-chain resource.
 * d) (scenario 6) the demo merchant's last completed day still reconciles `ok` with agentpay executions present
 *    (payments counts only `owner = payments` evidence).
 */
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createCheckoutSession, getAgentPayment, getCheckoutSession, listAgentPayments } from "@nearpay-money/spec";
import { ed25519 } from "@noble/curves/ed25519.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_AGENT_SEED_HEX, USDC } from "../../demo/agent.js";
import { loadAgentkit, mcpBin, nodeArgs } from "../../lib/artifacts.js";
import { McpClient, memoryLink, stdioChannel, type ToolResult, toolJson } from "../../lib/mcp.js";
import { base58Encode } from "../../lib/onboard.js";
import { md, realStack, stack, WEBHOOK_TIMEOUT_MS } from "../support/env.js";
import {
  api,
  EVIDENCE_NOT_COMPLETE,
  operator,
  reconcile,
  reconcileLatestCompleteDay,
  until,
} from "../support/stage2.js";
import { catalogue, demoDestination, getInv, sentInvoice, USDC_BASE } from "../support/stage3.js";

type AgentPayment = {
  id: string;
  kind: string;
  status: string;
  transfer_method?: string;
  pay_to: string;
  amount: string;
  binding: string | null;
  resource_url: string | null;
  checkout_session: string | null;
  tx_hash: string | null;
};

/** Test mode origin wallet: nothing to broadcast — the sandbox 1Click takes the reported tx as the deposit. */
const sandboxOrigin = {
  canPay: (network: string) => network.startsWith("eip155:"),
  refundTo: () => "0x000000000000000000000000000000000000dEaD",
  deposit: async () => ({ txHash: `0x${randomBytes(32).toString("hex")}` }),
};

/** A merchant HTTP server: `/premium` (sandbox scenario 00) and `/premium-fail` (scenario 04) behind the paywall. */
async function paywalledServer(): Promise<{ url: string; server: Server }> {
  const x402 = await loadAgentkit("x402");
  const st = stack();
  const opts = { secretKey: st.secretKey() as string, apiBase: st.apiUrl };
  const origins = [{ asset_id: USDC_BASE }];
  const handler = (amount: string) =>
    x402.withPaywall(
      (req: Request) => Response.json({ content: "premium", paidBy: x402.paymentOf(req)?.payer ?? null }),
      { amount, origins, includeIntentsTransfer: false, description: "testbed cross-chain resource" },
      opts,
    );
  const routes: Record<string, (r: Request) => Promise<Response>> = {
    "/premium": handler("10000"),
    "/premium-fail": handler("10004"),
  };
  const server = createServer(async (req, res) => {
    const host = req.headers.host ?? "localhost";
    const url = new URL(req.url ?? "/", `http://${host}`);
    const route = routes[url.pathname];
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const out = await route(new Request(url, { method: req.method ?? "GET", headers }));
    const outHeaders: Record<string, string> = {};
    out.headers.forEach((v, k) => {
      outHeaders[k] = v;
    });
    res.writeHead(out.status, outHeaders);
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://localhost:${(server.address() as AddressInfo).port}`, server };
}

const agentKey = () => {
  const seed = Uint8Array.from(Buffer.from(DEMO_AGENT_SEED_HEX, "hex"));
  return `ed25519:${base58Encode(Uint8Array.from([...seed, ...ed25519.getPublicKey(seed)]))}`;
};

/** `nearpay-mcp` configuration for the demo agent (test mode, sandbox Verifier). */
function mcpEnv(payTo: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const st = stack();
  const limits = {
    perCall: { [USDC]: "2000000", [USDC_BASE]: "2000000" },
    perSession: { [USDC]: "5000000", [USDC_BASE]: "5000000" },
  };
  return {
    ...process.env,
    NEARPAY_MCP_LIVEMODE: "false",
    NEARPAY_API_BASE: st.apiUrl,
    NEARPAY_MCP_NEAR_PRIVATE_KEY: agentKey(),
    NEARPAY_MCP_ALLOWED_PAY_TO: payTo,
    NEARPAY_MCP_LIMITS: JSON.stringify(limits),
    NEARPAY_MCP_SENTINEL_KEYS_FILE: `${st.deployDir}/.secrets/public/sentinel_keys.json`,
    NEARPAY_MCP_PAYMENT_HOSTS: new URL(st.payUrl).host,
    NEARPAY_MCP_PAY_API_BASE: st.payerApiUrl,
    NEARPAY_MCP_CHECKOUT_WAIT_MS: "120000",
    NEARPAY_MCP_FETCH_WAIT_MS: "240000",
    NEARPAY_MCP_ALLOW_HTTP: "true",
    ...extra,
  };
}

async function stdioMcp(env: NodeJS.ProcessEnv) {
  const ch = stdioChannel(nodeArgs(mcpBin()), env);
  const client = new McpClient(ch);
  try {
    await client.initialize();
  } catch (e) {
    throw new Error(`nearpay-mcp did not start: ${(e as Error).message}\n${ch.stderr()}`);
  }
  return { client, stderr: ch.stderr };
}

const ok = (r: ToolResult, what: string, stderr = () => "") => {
  if (r.isError) throw new Error(`${what}: ${JSON.stringify(toolJson(r))}\n${stderr().slice(-2000)}`);
  return toolJson<Record<string, unknown>>(r);
};
const errorCode = (r: ToolResult) => (toolJson<{ error?: { code?: string } }>(r).error?.code ?? "") as string;

describe.skipIf(!realStack)("Stage 3 · agents (x402 near-intents, MCP)", () => {
  let merchant: { url: string; server: Server };
  let payTo: string;
  beforeAll(async () => {
    merchant = await paywalledServer();
    payTo = (await demoDestination()).address;
  });
  afterAll(() => merchant?.server.close());

  it("a) cross-chain x402: 402 → quote → deposit → settled → 200, agent_payment.settled (near-intents)", async () => {
    const x402 = await loadAgentkit("x402");
    const signer = await loadAgentkit("agent-signer");
    const events: { method: string; settlement: { success: boolean; extra?: { agentPayment?: string } } | null }[] = [];
    const budget = new signer.SpendingBudget({
      perCall: { [USDC_BASE]: "2000000" },
      perSession: { [USDC_BASE]: "5000000" },
    });
    const pay = x402.withX402(fetch, null, {
      maxAmountPerRequest: { [USDC_BASE]: "2000000" },
      allowedPayTo: [payTo],
      budget,
      crossChain: { originSigner: sandboxOrigin, maxWaitMs: 240_000 },
      onPayment: (e: (typeof events)[number]) => events.push(e),
    });

    const plain = await fetch(`${merchant.url}/premium`);
    expect(plain.status).toBe(402);
    const required = x402.parsePaymentRequired(plain.headers.get("payment-required"));
    // near-intents entries are parsed apart from intents-transfer ones (this route offers cross-chain only)
    expect(required.accepts).toEqual([]);
    expect(required.nearIntents.length).toBeGreaterThan(0);
    expect(required.nearIntents[0].extra).toMatchObject({
      assetTransferMethod: "near-intents",
      originAssetId: USDC_BASE,
    });

    const res = await pay(`${merchant.url}/premium`);
    const body = await res.text();
    expect(res.status, body).toBe(200);
    expect(JSON.parse(body)).toMatchObject({ content: "premium" });
    const settlement = x402.decodeNearIntentsPaymentResponse(res);
    expect(settlement).toMatchObject({ success: true, network: "near:mainnet" });
    const apId = settlement.extra?.agentPayment as string;
    expect(apId).toMatch(/^ap_/);
    const ap = await api<AgentPayment>(getAgentPayment, { params: { id: apId } });
    expect(ap).toMatchObject({
      kind: "x402",
      status: "settled",
      transfer_method: "near-intents",
      pay_to: payTo,
    });
    // rails tags route amounts for attribution (lld/rails.md §20: the merchant may receive amount + tag, sub-cent);
    // agentpay reports the settled amount, never less than the price
    expect(BigInt(ap.amount)).toBeGreaterThanOrEqual(10000n);
    expect(BigInt(ap.amount) - 10000n).toBeLessThan(10000n);
    expect(ap.tx_hash).toBeTruthy();
    await md().waitForEvent({ type: "agent_payment.settled", object: apId }, WEBHOOK_TIMEOUT_MS);
    expect(events.at(-1)).toMatchObject({ method: "near-intents" });
  });

  it("a) a failed cross-chain delivery is refused and records no agent payment", async () => {
    const x402 = await loadAgentkit("x402");
    const pay = x402.withX402(fetch, null, {
      maxAmountPerRequest: { [USDC_BASE]: "2000000" },
      allowedPayTo: [payTo],
      crossChain: { originSigner: sandboxOrigin, maxWaitMs: 240_000 },
    });
    let status = 0;
    try {
      const res = await pay(`${merchant.url}/premium-fail`);
      status = res.status;
      await res.body?.cancel();
    } catch (e) {
      expect(String((e as { code?: string }).code ?? (e as Error).message)).toMatch(
        /payment_failed|settlement|deposit/,
      );
    }
    expect(status).not.toBe(200);
    const list = await api<{ data: AgentPayment[] }>(listAgentPayments, { query: { kind: "x402", limit: "100" } });
    expect(list.data.filter((a) => a.resource_url?.endsWith("/premium-fail"))).toEqual([]);
  });

  it("b) MCP (stdio): pays a checkout session and a hosted invoice within the budget, refuses beyond it", async () => {
    const { client, stderr } = await stdioMcp(mcpEnv(payTo));
    try {
      const tools = await client.tools();
      expect(tools).toEqual(
        expect.arrayContaining(["nearpay_pay_checkout_session", "nearpay_fetch_paid", "nearpay_get_spending"]),
      );

      const cs = await api<{ id: string; url: string }>(createCheckoutSession, {
        body: {
          amount: 100,
          currency: "usd",
          success_url: "https://example.com/mcp",
          description: "testbed MCP checkout",
        },
      });
      const paid = ok(await client.call("nearpay_pay_checkout_session", { url: cs.url }), "pay checkout", stderr);
      expect(paid.status).toBe("succeeded");
      const session = await until(
        () => api<{ status: string; payment_status?: string }>(getCheckoutSession, { params: { id: cs.id } }),
        (s) => s.status === "complete",
        120_000,
        `${cs.id} complete`,
      );
      expect(session.status).toBe("complete");
      const agentPayments = await api<{ data: AgentPayment[] }>(listAgentPayments, {
        query: { kind: "checkout", limit: "20" },
      });
      expect(agentPayments.data.some((a) => a.checkout_session === cs.id && a.status === "settled")).toBe(true);

      const cat = await catalogue("mcp", { unitAmount: 100 });
      const inv = await sentInvoice(cat, "mcp");
      const invPaid = ok(
        await client.call("nearpay_pay_checkout_session", { url: inv.hosted_invoice_url as string }),
        "pay invoice",
        stderr,
      );
      expect(invPaid.status).toBe("succeeded");
      await until(
        () => getInv(inv.id),
        (i) => i.status === "paid",
        180_000,
        `${inv.id} paid`,
      );

      const spending = ok(await client.call("nearpay_get_spending", {}), "spending");
      expect(JSON.stringify(spending)).toContain(USDC);

      // a lowered per-call limit refuses before anything is signed
      const cs2 = await api<{ id: string; url: string }>(createCheckoutSession, {
        body: { amount: 100, currency: "usd", success_url: "https://example.com/mcp" },
      });
      const refused = await client.call("nearpay_pay_checkout_session", { url: cs2.url, max_amount: "1000" });
      expect(refused.isError).toBe(true);
      expect(errorCode(refused)).toMatch(/limit/);
      expect((await api<{ status: string }>(getCheckoutSession, { params: { id: cs2.id } })).status).toBe("open");
    } finally {
      await client.close();
    }
  });

  it("b) MCP (stdio): a merchant that is not on the allow-list is refused", async () => {
    const { client } = await stdioMcp(mcpEnv("someone-else.near"));
    try {
      const cs = await api<{ id: string; url: string }>(createCheckoutSession, {
        body: { amount: 100, currency: "usd", success_url: "https://example.com/mcp" },
      });
      const r = await client.call("nearpay_pay_checkout_session", { url: cs.url });
      expect(r.isError).toBe(true);
      expect(errorCode(r)).toMatch(/pay_to|allow/);
      expect((await api<{ status: string }>(getCheckoutSession, { params: { id: cs.id } })).status).toBe("open");
    } finally {
      await client.close();
    }
  });

  it("c) MCP (embedded, test-mode origin signer): nearpay_fetch_paid pays the cross-chain resource", async () => {
    const mcp = await loadAgentkit("mcp");
    const { options, crossChain } = await mcp.optionsFromEnv(
      mcpEnv(payTo, { NEARPAY_MCP_CROSS_CHAIN_ORIGINS: USDC_BASE }),
    );
    options.payer.crossChain = { ...crossChain, originSigner: sandboxOrigin };
    const server = mcp.createNearPayMcpServer(options);
    const link = memoryLink();
    await server.connect(link.server);
    const client = new McpClient(link.client);
    try {
      await client.initialize();
      const r = ok(
        await client.call("nearpay_fetch_paid", { url: `${merchant.url}/premium`, max_wait_seconds: 240 }, 300_000),
        "fetch_paid",
      );
      expect(JSON.stringify(r)).toContain("premium");
      expect(JSON.stringify(r)).toMatch(/ap_[0-9a-z]+/);
    } finally {
      await client.close();
      await server.close?.();
    }
  });

  it("d) reconciliation of the last completed day is still ok with agentpay executions present", async () => {
    const op = await operator("ops", "recon3");
    const account = (await import("node:fs")).readFileSync(`${stack().deployDir}/.secrets/demo.json`, "utf8");
    const accountId = (JSON.parse(account) as { account: string }).account;
    const runs = await reconcileLatestCompleteDay(op, accountId);
    for (const refused of runs.slice(0, -1)) expect(refused.error).toMatch(EVIDENCE_NOT_COMPLETE);
    expect(runs.at(-1), JSON.stringify(runs.at(-1))).toMatchObject({ status: "ok", diff_count: 0 });
    if (process.env.NP_E2E_RECON_DAY) {
      const run = await reconcile(op, accountId, process.env.NP_E2E_RECON_DAY);
      expect(run, JSON.stringify(run)).toMatchObject({ status: "ok", diff_count: 0 });
    }
  });
});
