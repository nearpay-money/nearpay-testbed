/** merchant-demo against the mock stack: sessions, webhooks, orders, and the x402 loop with a real agent. */
import { nearSigner, staticSaltProvider } from "@nearpay-money/agent-signer";
import { decodePaymentResponse, withX402 } from "@nearpay-money/x402";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { merchantDemo } from "../../lib/merchant-demo.js";
import { type MockStack, startMerchantDemo, startMockStack, USDC } from "../support/mock-stack.js";

let stack: MockStack;
let demo: Awaited<ReturnType<typeof startMerchantDemo>>;
beforeAll(async () => {
  stack = await startMockStack();
  demo = await startMerchantDemo(stack);
});
afterAll(async () => {
  await demo.close();
  await stack.close();
});

describe("merchant-demo", () => {
  it("serves the shop page and health", async () => {
    const page = await (await fetch(`${demo.url}/`)).text();
    expect(page).toContain("Pay USD 2.00");
    expect(await (await fetch(`${demo.url}/healthz`)).json()).toStrictEqual({ status: "ok", seeded: true });
  });

  it("creates a USD 2.00 checkout session through the public API", async () => {
    const md = merchantDemo(demo.url);
    const s = await md.checkout();
    expect(s).toMatchObject({ amount: 200, currency: "usd", livemode: false });
    expect(s.url).toContain(`/c/${s.id}#${s.id}_secret_`);
    expect(stack.calls).toContain("POST /v1/checkout/sessions");
    const order = await md.order(s.id);
    expect(order).toMatchObject({
      id: s.id,
      status: "open",
      payment_intent: { id: s.payment_intent, status: "requires_payment" },
    });
  });

  it("redirects the browser form to the hosted checkout", async () => {
    const res = await fetch(`${demo.url}/checkout`, {
      method: "POST",
      body: new URLSearchParams(),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/\/c\/cs_[0-9a-z]{26}#cs_/);
  });

  it("accepts scenario amounts in test mode only and validates them", async () => {
    const md = merchantDemo(demo.url);
    expect((await md.checkout(205, 600)).amount).toBe(205);
    await expect(md.checkout(5)).rejects.toThrow(/400/);
    await expect(md.checkout(undefined, 10)).rejects.toThrow(/expires_in/);
    const live = await startMerchantDemo(stack, { NP_DEMO_SECRET_KEY: "sk_live_x" });
    await expect(merchantDemo(live.url).checkout(205)).rejects.toThrow(/test mode only/);
    await expect(merchantDemo(live.url).checkout(undefined, 600)).rejects.toThrow(/test mode only/);
    await live.close();
    stack.setWebhookUrl(`${demo.url}/webhooks`);
  });

  it("verifies webhooks and exposes them for the demo scripts", async () => {
    const bad = await fetch(`${demo.url}/webhooks`, {
      method: "POST",
      body: "{}",
      headers: { "NearPay-Signature": "t=1,v1=00" },
    });
    expect(bad.status).toBe(400);
    const md = merchantDemo(demo.url);
    const s = await md.checkout();
    const session = stack.sessions.get(s.id);
    if (!session) throw new Error("no session");
    // the mock delivers payment_intent.succeeded when the deposit is simulated
    const attempt = await fetch(`${stack.url}/v1/checkout/sessions/${s.id}/public/attempts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nearpay-client-secret": session.secret,
        "NearPay-Version": "2026-11-01",
      },
      body: JSON.stringify({
        method: "route_quote",
        origin_asset_id: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
        refund_to: "0x000000000000000000000000000000000000dEaD",
        turnstile_token: "x",
      }),
    }).then((r) => r.json() as Promise<{ id: string }>);
    await fetch(`${stack.url}/v1/checkout/sessions/${s.id}/public/attempts/${attempt.id}/simulate_deposit`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-nearpay-client-secret": session.secret },
      body: "{}",
    });
    const ev = await md.waitForEvent({ type: "payment_intent.succeeded", object: s.payment_intent }, 5_000, 50);
    expect(ev.event.data.object.status).toBe("succeeded");
    const order = await md.order(s.id);
    expect(order.status).toBe("complete");
    expect(order.events).toContain("payment_intent.succeeded");
  });

  it("sells /premium over x402: 402, agent pays, PAYMENT-RESPONSE, agent_payment.settled, replay refused", async () => {
    const plain = await fetch(`${demo.url}/premium`);
    expect(plain.status).toBe(402);
    let header = "";
    const agent = nearSigner({ keyPair: new Uint8Array(32).fill(2) });
    const pay = withX402(fetch, agent, {
      maxAmountPerRequest: { [USDC]: "10030" },
      nonceSaltProvider: staticSaltProvider("00000000"),
      onPayment: ({ payload }) => {
        header = Buffer.from(JSON.stringify(payload)).toString("base64");
      },
    });
    const res = await pay(`${demo.url}/premium`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ object: "premium_content", paid_by: agent.signerId });
    expect(decodePaymentResponse(res)).toMatchObject({ success: true, payer: agent.signerId, amount: "10000" });
    const md = merchantDemo(demo.url);
    const ev = await md.waitForEvent(
      { type: "agent_payment.settled", match: (e) => e.event.data.object.payer === agent.signerId },
      5_000,
      50,
    );
    expect(ev.event.data.object.resource_url).toBe(`${demo.url}/premium`);
    const replay = await fetch(`${demo.url}/premium`, { headers: { "PAYMENT-SIGNATURE": header } });
    expect(replay.status).toBe(402);
    expect(decodePaymentResponse(replay)?.errorReason).toBe("requirement_consumed");
  });

  it("answers 404 for unknown orders and 502 when the API is down", async () => {
    expect((await fetch(`${demo.url}/orders/nope`)).status).toBe(404);
    expect((await fetch(`${demo.url}/orders/cs_01jbz9k3m4n5p6q7r8s9t0v1w2`)).status).toBe(404);
    const down = await startMerchantDemo(stack, { NP_PUBLIC_API_URL: "http://127.0.0.1:9" });
    expect((await fetch(`${down.url}/checkout`, { method: "POST" })).status).toBe(502);
    expect((await fetch(`${down.url}/premium`)).status).toBe(503);
    await down.close();
    stack.setWebhookUrl(`${demo.url}/webhooks`);
  });

  it("refuses everything that needs the merchant key until seeded, and hides /events outside local/test", async () => {
    const unseeded = await startMerchantDemo(stack, { NP_DEMO_SECRET_KEY: "", NP_ENV: "production" });
    expect((await fetch(`${unseeded.url}/checkout`, { method: "POST" })).status).toBe(503);
    expect((await fetch(`${unseeded.url}/orders/cs_01jbz9k3m4n5p6q7r8s9t0v1w2`)).status).toBe(503);
    expect((await fetch(`${unseeded.url}/premium`)).status).toBe(503);
    expect((await fetch(`${unseeded.url}/events`)).status).toBe(404);
    const page = await (await fetch(`${unseeded.url}/success?session_id=cs_01jbz9k3m4n5p6q7r8s9t0v1w2`)).text();
    expect(page).toContain("cs_01jbz9k3m4n5p6q7r8s9t0v1w2");
    expect(await (await fetch(`${unseeded.url}/success`)).text()).toContain("No session");
    await unseeded.close();
    stack.setWebhookUrl(`${demo.url}/webhooks`);
  });
});
