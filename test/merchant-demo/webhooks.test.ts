/** Webhook verification against nearpay-spec/test-vectors/webhook-signatures.json (same file webhooks signs with). */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { EventStore, verifyWebhook } from "../../merchant-demo/src/webhooks.js";

const v = JSON.parse(
  readFileSync(
    createRequire(import.meta.url).resolve("@nearpay-money/spec/test-vectors/webhook-signatures.json"),
    "utf8",
  ),
);
const at = (t: number) => ({ now: t * 1000 });

describe("verifyWebhook", () => {
  it("accepts the vector (raw body bytes, UTF-8) and during rotation with either secret", () => {
    const r = verifyWebhook(Buffer.from(v.raw_body, "utf8"), v.header, [v.secret], at(v.verify_at));
    expect(r.ok && r.event.type).toBe("payment_intent.succeeded");
    expect(verifyWebhook(v.raw_body, v.header_during_rotation, [v.secondary_secret], at(v.verify_at)).ok).toBe(true);
    expect(verifyWebhook(v.raw_body, v.header, ["whsec_other", v.secret], at(v.verify_at)).ok).toBe(true);
  });

  it("rejects every negative vector", () => {
    const reasons = (v.negative as { raw_body: string; header: string; now: number }[]).map((n) => {
      const r = verifyWebhook(n.raw_body, n.header, [v.secret], at(n.now));
      return r.ok ? "ok" : r.reason;
    });
    expect(reasons).toStrictEqual(["signature_invalid", "signature_invalid", "signature_invalid"]);
  });

  it("rejects missing/malformed headers and unsigned garbage", () => {
    expect(verifyWebhook(v.raw_body, undefined, [v.secret])).toMatchObject({ reason: "missing_header" });
    expect(verifyWebhook(v.raw_body, "t=abc", [v.secret])).toMatchObject({ reason: "signature_invalid" });
    expect(verifyWebhook(v.raw_body, v.header, [], at(v.verify_at))).toMatchObject({ reason: "signature_invalid" });
    expect(verifyWebhook(v.raw_body, v.header, [v.secret], { ...at(v.verify_at + 1000), toleranceSec: 2000 }).ok).toBe(
      true,
    );
  });

  it("rejects a correctly signed body that is not an event", async () => {
    const { createHmac } = await import("node:crypto");
    const body = "not json";
    const t = 1_800_000_000;
    const sig = createHmac("sha256", v.secret).update(`${t}.${body}`).digest("hex");
    expect(verifyWebhook(body, `t=${t},v1=${sig}`, [v.secret], at(t)).ok).toBe(false); // the SDK refuses non-JSON
    const body2 = '{"id":"x"}';
    const sig2 = createHmac("sha256", v.secret).update(`${t}.${body2}`).digest("hex");
    expect(verifyWebhook(body2, `t=${t},v1=${sig2}`, [v.secret], at(t))).toMatchObject({ reason: "invalid_body" });
  });
});

describe("EventStore", () => {
  it("dedupes by id, filters by type and object, keeps the newest first, bounded", () => {
    const store = new EventStore(2);
    const ev = (id: `evt_${string}`, type: string, object: string) =>
      ({
        id,
        object: "event",
        type,
        api_version: "2026-11-01",
        created: 1,
        livemode: false,
        data: { object: { id: object } },
        request: { id: null, idempotency_key: null },
      }) as const;
    expect(store.add(ev("evt_1", "a", "pi_1"))).toBe(true);
    expect(store.add(ev("evt_1", "a", "pi_1"))).toBe(false);
    store.add(ev("evt_2", "b", "pi_1"));
    store.add({ ...ev("evt_3", "a", "pi_2"), data: { object: {} } });
    expect(store.list().map((e) => e.id)).toStrictEqual(["evt_3", "evt_2"]);
    expect(store.list({ type: "b", object: "pi_1" })).toHaveLength(1);
    expect(store.list({ object: "pi_2" })).toHaveLength(0);
  });
});
