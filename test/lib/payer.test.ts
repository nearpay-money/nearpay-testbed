/** Scripted payers (T3 human Intents balance, T5 agent) against the mock stack. */
import { nearSigner, payCheckoutSession, staticSaltProvider } from "@nearpay-money/agent-signer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError } from "../../lib/http.js";
import { merchantDemo } from "../../lib/merchant-demo.js";
import {
  ATTESTATION_TRIES,
  attestedAttempt,
  payFromIntentsBalance,
  retryUnavailable,
  sessionFromUrl,
} from "../../lib/payer.js";
import { type MockStack, SENTINEL_KEY, startMerchantDemo, startMockStack, USDC } from "../support/mock-stack.js";

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

async function newSession() {
  const s = await merchantDemo(demo.url).checkout();
  return { s, ...sessionFromUrl(s.url as string) };
}

describe("payers", () => {
  it("T3: a human pays from an Intents balance (attested requirement, NEP-413)", async () => {
    const { s, sessionId, clientSecret } = await newSession();
    const signer = nearSigner({ keyPair: new Uint8Array(32).fill(6) });
    const r = await payFromIntentsBalance(
      { apiBase: stack.url, sessionId, clientSecret, pinnedKeys: [SENTINEL_KEY] },
      signer,
      { originAssetId: USDC },
    );
    expect(r.attempt.method).toBe("intents_transfer");
    expect(r.merchant.name).toBe("Demo Shop");
    await merchantDemo(demo.url).waitForEvent(
      { type: "payment_intent.succeeded", object: s.payment_intent },
      5_000,
      50,
    );
  });

  it("T5: an agent pays a checkout session after verifying sentinel (agent-signer)", async () => {
    const { s } = await newSession();
    const signer = nearSigner({ keyPair: new Uint8Array(32).fill(7) });
    const r = await payCheckoutSession({ url: s.url as string, apiBase: stack.url }, signer, {
      pinnedKeys: [SENTINEL_KEY],
      maxAmount: { [USDC]: "2010000" },
      nonceSaltProvider: staticSaltProvider("00000000"),
    });
    expect(r.submission.status).toBe("submitted");
    await merchantDemo(demo.url).waitForEvent(
      { type: "payment_intent.succeeded", object: s.payment_intent },
      5_000,
      50,
    );
  });

  it("refuses unoffered options and unpinned co-signatures", async () => {
    const { sessionId, clientSecret } = await newSession();
    const c = { apiBase: stack.url, sessionId, clientSecret, pinnedKeys: [SENTINEL_KEY] };
    await expect(
      attestedAttempt(c, { method: "route_quote", originAssetId: "nep141:wrap.near", refundTo: "0x1" }),
    ).rejects.toThrow(/not offered/);
    await expect(
      attestedAttempt(
        { ...c, pinnedKeys: [] },
        { method: "intents_transfer", originAssetId: USDC, payerWallet: "a.near" },
      ),
    ).rejects.toThrow(/unknown_kid/);
  });

  it("sessionFromUrl reads hosted and embedded URLs", () => {
    const id = "cs_01jbz9k3m4n5p6q7r8s9t0v1w2";
    expect(sessionFromUrl(`https://pay.x/embed/${id}#${id}_secret_${"a".repeat(32)}`).sessionId).toBe(id);
    expect(() => sessionFromUrl(`https://pay.x/c/${id}`)).toThrow(/client secret/);
  });

  describe("sentinel unavailable (503 attestation_unavailable)", () => {
    const unavailable = () => new ApiError("503", 503, "attestation_unavailable", "req_1");
    const noSleep = async () => {};

    it("asks again with backoff and returns the first answer", async () => {
      const waits: number[] = [];
      let calls = 0;
      const r = await retryUnavailable(
        async () => {
          calls++;
          if (calls < 3) throw unavailable();
          return "signed";
        },
        async (ms) => {
          waits.push(ms);
        },
      );
      expect(r).toBe("signed");
      expect(waits).toStrictEqual([1000, 2000]);
    });

    it("gives up after a bounded number of tries", async () => {
      let calls = 0;
      await expect(
        retryUnavailable(async () => {
          calls++;
          throw unavailable();
        }, noSleep),
      ).rejects.toMatchObject({ code: "attestation_unavailable" });
      expect(calls).toBe(ATTESTATION_TRIES);
    });

    it("never retries a refusal or any other error", async () => {
      for (const e of [
        new ApiError("409", 409, "attestation_refused", undefined),
        new ApiError("401", 401, "ticket_invalid", undefined),
        new Error("network"),
      ]) {
        let calls = 0;
        await expect(
          retryUnavailable(async () => {
            calls++;
            throw e;
          }, noSleep),
        ).rejects.toBe(e);
        expect(calls).toBe(1);
      }
    });
  });
});
