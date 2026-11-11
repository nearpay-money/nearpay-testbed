import { createHash, createPublicKey, verify } from "node:crypto";
import dns from "node:dns";
import { nep413Hash } from "@nearpay-money/agent-signer";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { isLocalhostName } from "../../lib/localhost-dns.js";
import { base58Decode } from "../../lib/onboard.js";
import { DashboardSession, enrolmentToken, mailpit, OpsConsole, opsRoute } from "../../lib/ops-console.js";
import { checkSignIntent, DEMO_MERCHANT_SEED, type SignIntentAction, signNep413Intent } from "../../lib/refunds.js";
import { cbor, createCredential, getAssertion } from "../../lib/webauthn.js";

const ORIGIN = "https://ops.nearpay.localhost";
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest();
const CHALLENGE = "Og_tc_8tK82arp8g-4ejGonNIwKLodWvHxxZv2K_gOo";
const creation = (rpId: string) => ({
  challenge: CHALLENGE,
  rp: { name: "NearPay Console", id: rpId },
  user: { id: "AaG6TOrwcIaFEHqGqMT8Dw", name: "ops@nearpay.localhost", displayName: "ops@nearpay.localhost" },
  pubKeyCredParams: [{ alg: -7, type: "public-key" }],
  timeout: 300000,
  attestation: "direct",
  excludeCredentials: [],
  authenticatorSelection: { residentKey: "required", userVerification: "required", requireResidentKey: true },
});
const request = (rpId: string) => ({ rpId, challenge: "fqt8rBUWiduqxHX0Vq61H7OcyfzpqjCQH-p-xWfx4Uw", timeout: 300000 });
const opsSession = (csrf: string) => ({
  object: "ops_session",
  operator: { id: "usr_01m6x4stqge238a43tgtmc9z0f", email: "ops@nearpay.localhost" },
  role: "ops_admin",
  csrf_token: csrf,
  step_up_until: 1794127566,
  idle_expires_at: 1794128766,
  expires_at: 1794170166,
});

describe("software authenticator", () => {
  it("encodes CBOR heads for every size class", () => {
    expect(cbor(23)).toEqual(Buffer.from([23]));
    expect(cbor(24)).toEqual(Buffer.from([24, 24]));
    expect(cbor(300)).toEqual(Buffer.from([25, 1, 44]));
    expect(cbor(70_000)).toEqual(Buffer.from([26, 0, 1, 17, 112]));
    expect(cbor(-7)).toEqual(Buffer.from([0x26]));
    expect(cbor("fmt")).toEqual(Buffer.from([0x63, 0x66, 0x6d, 0x74]));
  });

  it("registers (packed self attestation, UV, zero AAGUID) and asserts with a verifiable signature", () => {
    const { credential, response } = createCredential(creation("ops.nearpay.localhost"), ORIGIN);
    const client = JSON.parse(Buffer.from(response.response.clientDataJSON, "base64url").toString());
    expect(client).toMatchObject({ type: "webauthn.create", challenge: CHALLENGE, origin: ORIGIN });
    const att = Buffer.from(response.response.attestationObject, "base64url");
    expect(att.includes(Buffer.from("packed"))).toBe(true);
    const ad = att.subarray(att.length - (37 + 16 + 2 + 32 + 77));
    expect(ad.subarray(0, 32)).toEqual(sha("ops.nearpay.localhost"));
    expect(ad[32]).toBe(0x45); // UP | UV | AT, not backed up
    expect(ad.subarray(37, 53)).toEqual(Buffer.alloc(16));

    const a = getAssertion(request("ops.nearpay.localhost"), ORIGIN, credential);
    expect(credential.signCount).toBe(1);
    const authData = Buffer.from(a.response.authenticatorData, "base64url");
    expect(authData[32]).toBe(0x05);
    const signed = Buffer.concat([authData, sha(Buffer.from(a.response.clientDataJSON, "base64url"))]);
    const pub = createPublicKey(credential.privateKeyPem);
    expect(verify("sha256", signed, pub, Buffer.from(a.response.signature, "base64url"))).toBe(true);
    expect(getAssertion({ challenge: "x" }, ORIGIN, credential).id).toBe(credential.id);
    expect(credential.signCount).toBe(2);
  });
});

describe("refund signing", () => {
  const message = (o: Partial<{ amount: string; memo: string; deadline: string; signer: string; n: number }> = {}) =>
    JSON.stringify({
      signer_id: o.signer ?? "merchant-demo.near",
      deadline: o.deadline ?? new Date(Date.now() + 600_000).toISOString(),
      intents: Array.from({ length: o.n ?? 1 }, () => ({
        intent: "transfer",
        receiver_id: "payer.near",
        tokens: { "nep141:usdc": o.amount ?? "100" },
        memo: o.memo ?? "np1:x",
      })),
    });
  const action = (m = message()): SignIntentAction => ({
    type: "sign_intent",
    signer_id: "merchant-demo.near",
    transfer: { receiver_id: "payer.near", token: "nep141:usdc", amount: "100", memo: "np1:x" },
    nep413: { recipient: "intents.near", nonce: Buffer.alloc(32, 7).toString("base64"), message: m },
  });
  const refund = { asset_id: "nep141:usdc" };

  it("accepts a consistent action and refuses every inconsistency (dashboard checks)", () => {
    expect(() => checkSignIntent(action(), refund)).not.toThrow();
    for (const bad of [
      message({ signer: "other.near" }),
      message({ deadline: "2020-01-01T00:00:00Z" }),
      message({ amount: "99" }),
      message({ memo: "np1:y" }),
      message({ n: 2 }),
    ])
      expect(() => checkSignIntent(action(bad), refund)).toThrow(/refusing/);
    expect(() => checkSignIntent(action(), { asset_id: "nep141:other" })).toThrow(/asset/);
    const zero = action();
    zero.transfer.amount = "0";
    expect(() => checkSignIntent(zero, refund)).toThrow(/positive/);
    const recv = action();
    recv.transfer.receiver_id = "x.near";
    expect(() => checkSignIntent(recv, refund)).toThrow(/receiver/);
  });

  it("signs the issued NEP-413 message verbatim", () => {
    const a = action();
    const p = signNep413Intent(a, DEMO_MERCHANT_SEED) as unknown as {
      payload: { message: string; nonce: string; recipient: string };
      public_key: string;
      signature: string;
    };
    expect(p.payload).toEqual(a.nep413);
    const hash = nep413Hash(a.nep413.message, Uint8Array.from(Buffer.alloc(32, 7)), "intents.near");
    const sig = base58Decode(p.signature.slice("ed25519:".length));
    const pub = base58Decode(p.public_key.slice("ed25519:".length));
    expect(ed25519.verify(sig, hash, pub)).toBe(true);
  });
});

/** A fake host answering the auth ceremonies like identity (shapes recorded from the local stack). */
function fakeHost(rpId: string) {
  const calls: { method: string; path: string; headers: Record<string, string>; body: unknown }[] = [];
  let stepUpDone = false;
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(body === null ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  const f: typeof fetch = async (url, init) => {
    const u = new URL(String(url));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", path: u.pathname, headers, body });
    switch (u.pathname) {
      case "/api/ops/auth/enrolment/verify":
        return json(200, {
          object: "ops_registration",
          registration_token: "QPci2KmZPck6xCrOnprwaQbKqI_-vxwGuRxhcPIqmsc",
          email: "ops@nearpay.localhost",
          expires_at: 1794127266,
        });
      case "/api/ops/auth/passkeys/registration/options":
      case "/api/v1/auth/passkeys/registration/options":
        return json(200, creation(rpId));
      case "/api/ops/auth/passkeys/registration/verify":
        return json(200, opsSession("csrf-1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), {
          "set-cookie": "np_ops=s1; Path=/; HttpOnly; Secure",
        });
      case "/api/ops/auth/passkeys/authentication/options":
      case "/api/ops/auth/step_up/options":
      case "/api/v1/auth/step_up/options":
        return json(200, request(rpId));
      case "/api/ops/auth/passkeys/authentication/verify":
        return json(200, opsSession("csrf-2-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), {
          "set-cookie": "np_ops=s2; Path=/; HttpOnly; Secure",
        });
      case "/api/ops/auth/step_up/verify":
        stepUpDone = true;
        return json(200, opsSession("csrf-2-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
      case "/api/ops/kill_switch/engage":
        if (!stepUpDone)
          return json(401, {
            error: {
              type: "authentication_error",
              code: "step_up_required",
              message: "needs step-up",
              request_id: "req_01m6x4stqge238a43tgtmc9z0f",
              doc_url: "https://docs.nearpay.money/errors/step_up_required",
            },
          });
        return json(200, {
          engaged: true,
          reason: "drill",
          actor: "usr_01m6x4stqge238a43tgtmc9z0f",
          updated_at: "2026-11-08T00:00:00.000Z",
          version: 1,
          pending_release: null,
        });
      case "/api/ops/kill_switch":
        return json(403, {
          error: {
            type: "permission_error",
            code: "permission_denied",
            message: "no",
            request_id: "req_01m6x4stqge238a43tgtmc9z0g",
            doc_url: "https://docs.nearpay.money/errors/permission_denied",
          },
        });
      case "/api/v1/auth/signup":
        return json(202, null);
      case "/api/v1/auth/magic_links/verify":
        return json(200, {
          object: "registration",
          registration_token: "nMosXgqLlawYHmOJ0Hm07bK7TMj8s5N8LJvb8CA0HE8",
          email: "m@merchant.test",
          expires_at: 1794127264,
          purpose: "signup",
        });
      case "/api/v1/auth/passkeys/registration/verify":
        return json(
          200,
          {
            object: "dashboard_session",
            user: { id: "usr_01m6x4ssk2e1nv4drtrs7txkr9", email: "m@merchant.test" },
            account: { id: "acct_01m6x4ssk3e6xs71se5wtftt33", display_name: "Cap" },
            role: "owner",
            csrf_token: "csrf-d-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            expires_at: 1794731764,
          },
          { "set-cookie": "np_session=d1; Path=/; HttpOnly; Secure" },
        );
      default:
        return json(404, { error: { type: "invalid_request_error", code: "resource_missing", message: "?" } });
    }
  };
  return { f, calls };
}

describe("console and dashboard session clients", () => {
  it("enrols an operator, keeps the cookie jar and CSRF, answers step_up_required and replays with the same key", async () => {
    const host = fakeHost("ops.nearpay.localhost");
    const op = await OpsConsole.enrol(ORIGIN, "B2JNgPsnk9bpK0iuundNfuNVjdKKdTjo7TkVUTMUZ5M", host.f);
    const engaged = await op.call<{ engaged: boolean }>(opsRoute("engageOpsKillSwitch"), { body: { reason: "drill" } });
    expect(engaged.engaged).toBe(true);
    const writes = host.calls.filter((c) => c.path === "/api/ops/kill_switch/engage");
    expect(writes).toHaveLength(2);
    expect(writes[0]?.headers["Idempotency-Key"]).toBeTruthy();
    expect(writes[1]?.headers["Idempotency-Key"]).toBe(writes[0]?.headers["Idempotency-Key"]);
    expect(writes[1]?.headers.cookie).toBe("np_ops=s2");
    expect(writes[1]?.headers["X-CSRF-Token"]).toBe("csrf-2-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(writes[1]?.headers.origin).toBe(ORIGIN);
    await expect(op.call(opsRoute("getOpsKillSwitch"))).rejects.toMatchObject({
      status: 403,
      code: "permission_denied",
    });
    expect(() => opsRoute("nope")).toThrow(RangeError);
  });

  it("signs a merchant up through the dashboard host (magic link from Mailpit, passkey, live mode header)", async () => {
    const host = fakeHost("nearpay.localhost");
    const mail = {
      latest: async () => "Sign up: https://dashboard.nearpay.localhost/auth/verify#token=AbCdEfGhIjKlMnOpQrSt",
    };
    const s = await DashboardSession.signUp(
      "https://dashboard.nearpay.localhost",
      { email: "m@merchant.test", displayName: "Cap", mail, turnstileToken: "XXXX.DUMMY.TOKEN.XXXX" },
      host.f,
    );
    expect(s.credential.rpId).toBe("nearpay.localhost");
    s.mode = "live";
    await s.stepUp().catch(() => undefined); // StepUp response shape differs; the call itself is what is checked
    const up = host.calls.find((c) => c.path === "/api/v1/auth/step_up/options");
    expect(up?.headers["NearPay-Mode"]).toBe("live");
    expect(up?.headers.cookie).toBe("np_session=d1");
    await expect(
      DashboardSession.signUp(
        "https://dashboard.nearpay.localhost",
        { email: "m@merchant.test", displayName: "Cap", mail: { latest: async () => "no link" }, turnstileToken: "t" },
        host.f,
      ),
    ).rejects.toThrow(/no magic link/);
  });

  it("parses enrolment links and reads Mailpit", async () => {
    expect(
      enrolmentToken("Register: https://ops.nearpay.localhost/auth/enrol#token=B2JNgPsnk9bpK0iuundNfuNVjdKK"),
    ).toBe("B2JNgPsnk9bpK0iuundNfuNVjdKK");
    expect(() => enrolmentToken("nothing")).toThrow();
    let n = 0;
    const f: typeof fetch = async (url) => {
      const u = String(url);
      if (u.includes("/search")) {
        n++;
        return Response.json({
          messages:
            n < 2
              ? []
              : [{ ID: "m1", Subject: "[NearPay ops] Set up your console access", Created: new Date().toISOString() }],
        });
      }
      return Response.json({ Text: "hello" });
    };
    expect(await mailpit("https://mail.x", f).latest("a@b.c", /console/, 5000)).toBe("hello");
    const never: typeof fetch = async () => Response.json({ messages: [] });
    await expect(mailpit("https://mail.x", never).latest("a@b.c", /x/, 10)).rejects.toThrow(/no mail/);
  });
});

describe("*.localhost resolution", () => {
  it("resolves localhost names to loopback and leaves other names to the system resolver", async () => {
    expect(isLocalhostName("api.nearpay.localhost")).toBe(true);
    expect(isLocalhostName("localhost")).toBe(true);
    expect(isLocalhostName("example.com")).toBe(false);
    // the patched `dns.lookup` (what net/undici call at connect time)
    const l = (host: string, o?: number | dns.LookupAllOptions | dns.LookupOneOptions) =>
      new Promise<unknown>((res, rej) =>
        dns.lookup(host, (o ?? {}) as dns.LookupOptions, (e, address, family) =>
          e ? rej(e) : res(typeof address === "string" ? { address, family } : address),
        ),
      );
    expect(await l("api.nearpay.localhost")).toMatchObject({ address: "127.0.0.1", family: 4 });
    expect(await l("api.nearpay.localhost", { family: 6 })).toMatchObject({ address: "::1", family: 6 });
    expect(await l("api.nearpay.localhost", { all: true })).toEqual([{ address: "127.0.0.1", family: 4 }]);
    expect(await l("api.nearpay.localhost", 4)).toMatchObject({ address: "127.0.0.1" });
    expect(await l("127.0.0.1")).toMatchObject({ address: "127.0.0.1" });
  });
});
