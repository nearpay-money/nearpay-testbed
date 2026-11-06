/** demo:checkout and demo:agent end to end against the mock stack + merchant-demo (test mode). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAgentDemo } from "../demo/agent.js";
import { runCheckoutDemo } from "../demo/checkout.js";
import { type MockStack, startMerchantDemo, startMockStack } from "./support/mock-stack.js";
import { mockStackConfig } from "./support/stack.js";

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

describe("demo:checkout (steps 2–4)", () => {
  it("creates a USD 2.00 session, pays it in test mode after verifying sentinel, waits for the signed webhook", async () => {
    const lines: string[] = [];
    const r = await runCheckoutDemo(["--timeout", "10"], {
      stack: mockStackConfig(stack, demo.url),
      log: (s) => lines.push(s),
    });
    expect(r).toMatchObject({ livemode: false, amountSettled: "2000000" });
    expect(lines.join("\n")).toMatch(/attested merchant: Demo Shop {2}destination YZMN-R81Z-BR/);
    expect(lines.join("\n")).toContain("received with a valid signature");
  });

  it("refuses to pay when sentinel's co-signature does not verify with the pinned key", async () => {
    const cfg = {
      ...mockStackConfig(stack, demo.url),
      pinnedKeys: () => [{ kid: "sent-test-1", public_key: "fGYI2Mzd_mP5tqEYEJggL6jJE2SOhX9CvdDBLOxgkiE" }],
    };
    await expect(runCheckoutDemo(["--timeout", "1"], { stack: cfg, log: () => {} })).rejects.toThrow(/bad_signature/);
  });

  it("--no-pay only creates the session and times out waiting", async () => {
    await expect(
      runCheckoutDemo(["--no-pay", "--timeout", "1"], { stack: mockStackConfig(stack, demo.url), log: () => {} }),
    ).rejects.toThrow(/timed out/);
  });
});

describe("demo:agent (step 5)", () => {
  it("402 → withX402 pays → 200 + PAYMENT-RESPONSE → agent_payment.settled", async () => {
    const lines: string[] = [];
    const r = await runAgentDemo(["--timeout", "10"], {
      stack: mockStackConfig(stack, demo.url),
      env: {},
      log: (s) => lines.push(s),
    });
    expect(r.payer).toBe("0857962d91335176f92257df38175401936a4ca31b832f0c98c77b836800c655");
    expect(r.eventId).toMatch(/^evt_/);
    expect(lines[1]).toMatch(/402 Payment Required: 10000 \+ fee 30/);
  });

  it("uses the configured agent key and refuses above its spend limit", async () => {
    const env = { NP_AGENT_SECRET_KEY: `ed25519:${"3".repeat(44)}`, NP_AGENT_ACCOUNT: "agent.near" };
    await expect(
      runAgentDemo(["--max", "100"], { stack: mockStackConfig(stack, demo.url), env, log: () => {} }),
    ).rejects.toThrow(/exceeds the limit/);
  });

  it("needs a key in live mode", async () => {
    await expect(
      runAgentDemo(["--live"], { stack: mockStackConfig(stack, demo.url), env: {}, log: () => {} }),
    ).rejects.toThrow(/NP_AGENT_SECRET_KEY/);
  });
});
