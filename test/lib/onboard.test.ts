import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nep413Hash } from "@nearpay/agent-signer";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import {
  appendSecret,
  base58Decode,
  base58Encode,
  credentialForReuse,
  DEFAULT_BUSINESS,
  DEFAULT_EMAIL,
  DEFAULT_WEBHOOK_URL,
  demoKybProfile,
  fileMode,
  findDestination,
  generateMerchantKey,
  hasSecretHash,
  keyInFile,
  keyPrefix,
  kybStep,
  loadPasskey,
  loadState,
  type PasskeyRecord,
  parseMerchantKey,
  parseOnboardArgs,
  passkeyRecord,
  pickCredential,
  readSecret,
  readSecretList,
  SIGN_COUNT_MARGIN,
  savePasskey,
  saveState,
  sha256Hex,
  signNep413,
  USDC_NEAR,
  type VirtualCredential,
  writePrivateFile,
} from "../../lib/onboard.js";

const tmp = () => mkdtempSync(join(tmpdir(), "np-onboard-"));
const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const PUB = ed25519.getPublicKey(SEED);
const ACCOUNT = Buffer.from(PUB).toString("hex");
const PUBLIC_KEY = `ed25519:${base58Encode(PUB)}`;
const PRIVATE_64 = `ed25519:${base58Encode(Uint8Array.from([...SEED, ...PUB]))}`;

const credential = (o: Partial<VirtualCredential> = {}): VirtualCredential => ({
  credentialId: "q1w2e3r4t5y6u7i8o9p0aa==",
  isResidentCredential: true,
  rpId: "nearpay.localhost",
  privateKey: "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg",
  userHandle: "dXNlcg==",
  signCount: 3,
  backupEligibility: false,
  ...o,
});

describe("base58", () => {
  it("round-trips, keeping leading zero bytes", () => {
    for (const b of [new Uint8Array(0), Uint8Array.from([0, 0, 1, 2]), PUB, Uint8Array.from([255])]) {
      expect(base58Decode(base58Encode(b))).toStrictEqual(b);
    }
    expect(base58Encode(Uint8Array.from([0, 0]))).toBe("11");
  });

  it("rejects characters outside the alphabet", () => {
    expect(() => base58Decode("0OIl")).toThrow("not base58");
  });
});

describe("parseMerchantKey", () => {
  it("reads near-cli JSON of an implicit account (64-byte and 32-byte private keys)", () => {
    const k = parseMerchantKey(
      JSON.stringify({ account_id: ACCOUNT, public_key: PUBLIC_KEY, private_key: PRIVATE_64 }),
    );
    expect(k).toStrictEqual({ accountId: ACCOUNT, publicKey: PUBLIC_KEY, seed: SEED });
    const short = parseMerchantKey(
      JSON.stringify({ implicit_account_id: ACCOUNT, secret_key: `ed25519:${base58Encode(SEED)}` }),
    );
    expect(short.publicKey).toBe(PUBLIC_KEY);
  });

  it.each([
    ["not json", "{", /not JSON/],
    ["not an object", "null", /not a JSON object/],
    ["no account", JSON.stringify({ private_key: PRIVATE_64 }), /missing account_id/],
    ["no private key", JSON.stringify({ account_id: ACCOUNT }), /missing private_key/],
    ["secp256k1", JSON.stringify({ account_id: ACCOUNT, private_key: "secp256k1:abc" }), /ed25519/],
    ["bad base58", JSON.stringify({ account_id: ACCOUNT, private_key: "ed25519:0OIl" }), /not base58/],
    ["bad length", JSON.stringify({ account_id: ACCOUNT, private_key: "ed25519:abc" }), /unexpected length/],
    [
      "embedded key mismatch",
      JSON.stringify({
        account_id: ACCOUNT,
        private_key: `ed25519:${base58Encode(Uint8Array.from([...SEED, ...new Uint8Array(32).fill(7)]))}`,
      }),
      /embedded public key/,
    ],
    [
      "public key mismatch",
      JSON.stringify({
        account_id: ACCOUNT,
        public_key: `ed25519:${base58Encode(new Uint8Array(32).fill(9))}`,
        private_key: PRIVATE_64,
      }),
      /public_key does not match/,
    ],
    [
      "named account",
      JSON.stringify({ account_id: "merchant.near", private_key: PRIVATE_64 }),
      /not the implicit account/,
    ],
  ])("rejects %s without echoing the key", (_name, text, error) => {
    let message = "";
    try {
      parseMerchantKey(text, "merchant.json");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(error);
    expect(message).toMatch(/^merchant\.json: /);
    expect(message).not.toContain(PRIVATE_64.slice(8));
  });

  it("generateMerchantKey writes a 0600 near-cli file that parses back", () => {
    const file = join(tmp(), "accounts", "merchant.json");
    const k = generateMerchantKey(file, SEED);
    expect(k.accountId).toBe(ACCOUNT);
    expect(fileMode(file)).toBe(0o600);
    expect(parseMerchantKey(readFileSync(file, "utf8"))).toStrictEqual(k);
    expect(generateMerchantKey(join(tmp(), "random.json")).accountId).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("signNep413", () => {
  it("signs the NEP-413 hash of the challenge with the merchant key", () => {
    const k = parseMerchantKey(JSON.stringify({ account_id: ACCOUNT, private_key: PRIVATE_64 }));
    const nonce = Buffer.alloc(32, 5).toString("base64");
    const c = { message: "NearPay destination attestation", recipient: "nearpay.money", nonce };
    const s = signNep413(k, c);
    expect(s.public_key).toBe(PUBLIC_KEY);
    const hash = nep413Hash(c.message, Buffer.from(nonce, "base64"), c.recipient);
    expect(ed25519.verify(Buffer.from(s.signature, "base64"), hash, PUB)).toBe(true);
  });
});

describe("private files", () => {
  it("writePrivateFile creates 0700 directories and 0600 files, replacing content atomically", () => {
    const dir = join(tmp(), "a", "b");
    const file = join(dir, "secret_key");
    writePrivateFile(file, "one\n");
    writePrivateFile(file, "two\n");
    expect(readFileSync(file, "utf8")).toBe("two\n");
    expect(fileMode(file)).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(fileMode(join(dir, "missing"))).toBeNull();
    expect(readSecret(file)).toBe("two");
    expect(readSecret(join(dir, "missing"))).toBeNull();
  });

  it("appendSecret keeps existing entries, adds once, and tightens the mode to 0600", () => {
    const file = join(tmp(), "webhook_secret");
    writeFileSync(file, "whsec_old1, whsec_old2\n", { mode: 0o644 });
    expect(appendSecret(file, "whsec_new")).toStrictEqual({ added: true, count: 3 });
    expect(readFileSync(file, "utf8")).toBe("whsec_old1,whsec_old2,whsec_new\n");
    expect(fileMode(file)).toBe(0o600);
    expect(appendSecret(file, "whsec_new")).toStrictEqual({ added: false, count: 3 });
    expect(readSecretList(file)).toStrictEqual(["whsec_old1", "whsec_old2", "whsec_new"]);
  });

  it("hasSecretHash finds a secret in the file by its SHA-256 only", () => {
    const file = join(tmp(), "webhook_secret");
    writeFileSync(file, "whsec_a,whsec_b\n");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hasSecretHash(file, sha256Hex("whsec_b"))).toBe(true);
    expect(hasSecretHash(file, sha256Hex("whsec_c"))).toBe(false);
    expect(hasSecretHash(file, undefined)).toBe(false);
    expect(hasSecretHash(join(tmp(), "missing"), sha256Hex("whsec_a"))).toBe(false);
  });

  it("appendSecret starts a missing file and refuses malformed secrets", () => {
    const file = join(tmp(), "merchant-demo", "webhook_secret");
    expect(readSecretList(file)).toStrictEqual([]);
    expect(appendSecret(file, "whsec_first")).toStrictEqual({ added: true, count: 1 });
    expect(readFileSync(file, "utf8")).toBe("whsec_first\n");
    for (const bad of ["", "a,b", "with space", "line\nbreak"]) {
      expect(() => appendSecret(file, bad)).toThrow("malformed");
    }
  });
});

describe("saved passkey", () => {
  it("saves with mode 0600 and loads the same credential back", () => {
    const file = join(tmp(), "accounts", "merchant-passkey.json");
    const rec = passkeyRecord("m@nearpay.localhost", credential(), new Date("2026-11-07T00:00:00Z"));
    expect(rec.rp_id).toBe("nearpay.localhost");
    savePasskey(file, rec);
    expect(fileMode(file)).toBe(0o600);
    expect(loadPasskey(file)).toStrictEqual(rec);
    expect(loadPasskey(join(tmp(), "none.json"))).toBeNull();
  });

  it("fills rp_id and saved_at when an older file lacks them", () => {
    const file = join(tmp(), "p.json");
    writeFileSync(file, JSON.stringify({ version: 1, email: "m@x.test", credential: credential() }));
    expect(loadPasskey(file)).toMatchObject({ rp_id: "nearpay.localhost", saved_at: "" });
    const nonResident = credential({ isResidentCredential: false, rpId: undefined });
    expect(passkeyRecord("m@x.test", nonResident).rp_id).toBe("");
    writeFileSync(file, JSON.stringify({ version: 1, email: "m@x.test", credential: nonResident }));
    expect(loadPasskey(file)?.rp_id).toBe("");
  });

  it.each([
    ["not json", "{"],
    ["version", JSON.stringify({ version: 2, email: "m@x.test", credential: credential() })],
    ["email", JSON.stringify({ version: 1, email: "nope", credential: credential() })],
    ["credential", JSON.stringify({ version: 1, email: "m@x.test" })],
    ["credentialId", JSON.stringify({ version: 1, email: "m@x.test", credential: credential({ credentialId: "%%" }) })],
    [
      "privateKey",
      JSON.stringify({ version: 1, email: "m@x.test", credential: credential({ privateKey: 1 as never }) }),
    ],
    [
      "resident flag",
      JSON.stringify({ version: 1, email: "m@x.test", credential: credential({ isResidentCredential: "y" as never }) }),
    ],
    ["signCount", JSON.stringify({ version: 1, email: "m@x.test", credential: credential({ signCount: -1 }) })],
    ["rpId", JSON.stringify({ version: 1, email: "m@x.test", credential: credential({ rpId: "" }) })],
  ])("refuses a malformed file (%s)", (_name, text) => {
    const file = join(tmp(), "p.json");
    writeFileSync(file, text);
    expect(() => loadPasskey(file)).toThrow();
  });

  it("savePasskey refuses to write a malformed credential", () => {
    const rec = { ...passkeyRecord("m@x.test", credential()), credential: credential({ privateKey: "" }) };
    expect(() => savePasskey(join(tmp(), "p.json"), rec as PasskeyRecord)).toThrow("privateKey");
  });

  it("reuses the credential with its counter moved ahead", () => {
    const rec = passkeyRecord("m@x.test", credential({ signCount: 7 }));
    expect(credentialForReuse(rec).signCount).toBe(7 + SIGN_COUNT_MARGIN);
    expect(credentialForReuse(rec, 1)).toStrictEqual({ ...rec.credential, signCount: 8 });
    expect(rec.credential.signCount).toBe(7);
  });

  it("pickCredential finds the saved credential, or the only one after a sign-up", () => {
    const a = credential({ credentialId: "aaaa" });
    const b = credential({ credentialId: "bbbb" });
    expect(pickCredential([a, b], "bbbb")).toBe(b);
    expect(pickCredential([a], "cccc")).toBeNull();
    expect(pickCredential([a])).toBe(a);
    expect(pickCredential([a, b])).toBeNull();
    expect(pickCredential([])).toBeNull();
  });
});

describe("state file", () => {
  it("round-trips ids and ignores unknown or non-string fields", () => {
    const file = join(tmp(), "merchant-onboard.json");
    expect(loadState(file)).toStrictEqual({});
    const state = { account_id: "acct_1", webhook_endpoint_id: "we_1", webhook_secret_sha256: sha256Hex("whsec_x") };
    saveState(file, state);
    expect(fileMode(file)).toBe(0o600);
    expect(loadState(file)).toStrictEqual(state);
    writeFileSync(file, JSON.stringify({ email: "m@x.test", destination_id: 5, other: "x" }));
    expect(loadState(file)).toStrictEqual({ email: "m@x.test" });
    writeFileSync(file, "{");
    expect(() => loadState(file)).toThrow("not JSON");
  });
});

describe("API objects", () => {
  const d = (o: Partial<Parameters<typeof findDestination>[0][number]>) => ({
    id: "sd_1",
    type: "intents_account",
    address: ACCOUNT,
    asset_id: USDC_NEAR,
    status: "active",
    livemode: true,
    created: 1,
    ...o,
  });

  it("findDestination picks the newest live, not disabled, Intents destination of the account", () => {
    const list = [
      d({ id: "sd_test", livemode: false, created: 9 }),
      d({ id: "sd_disabled", status: "disabled", created: 8 }),
      d({ id: "sd_chain", type: "chain_address", created: 7 }),
      d({ id: "sd_other", address: "other.near", created: 6 }),
      d({ id: "sd_asset", asset_id: "nep141:wrap.near", created: 5 }),
      d({ id: "sd_old", created: 1 }),
      d({ id: "sd_new", status: "cooling_off", created: 3 }),
    ];
    expect(findDestination(list, ACCOUNT)?.id).toBe("sd_new");
    expect(findDestination(list, "nobody")).toBeUndefined();
  });

  it("keyInFile matches the live secret key whose secret is in the file", () => {
    const keys = [
      { id: "key_test", type: "secret", livemode: false, display_prefix: "sk_test_", last4: "WXYZ" },
      { id: "key_pk", type: "publishable", livemode: true, display_prefix: "pk_live_", last4: "WXYZ" },
      { id: "key_live", type: "secret", livemode: true, display_prefix: "sk_live_", last4: "WXYZ" },
    ];
    expect(keyInFile(keys, "sk_live_abcdefWXYZ")?.id).toBe("key_live");
    expect(keyInFile(keys, "sk_live_abcdefABCD")).toBeUndefined();
    expect(keyInFile(keys, "sk_test_abcdefWXYZ")).toBeUndefined();
    expect(keyInFile(keys, "sk_live_WXYZ")).toBeUndefined();
    expect(keyInFile(keys, null)).toBeUndefined();
  });

  it("keyPrefix shows the key prefix only", () => {
    expect(keyPrefix("sk_live_0123456789abcdef")).toBe("sk_live_…");
    expect(keyPrefix("pk_test_0123")).toBe("pk_test_…");
    expect(keyPrefix("whsec_secret")).toBe("…");
  });
});

describe("parseOnboardArgs", () => {
  it("defaults to the deploy checkout's .secrets and the demo merchant", () => {
    const o = parseOnboardArgs([], {}, "/work/nearpay-testbed");
    expect(o).toStrictEqual({
      email: DEFAULT_EMAIL,
      business: DEFAULT_BUSINESS,
      country: "GB",
      kybMode: "auto",
      deployDir: "/work/nearpay-deploy",
      merchantKeyFile: "/work/nearpay-deploy/.secrets/accounts/merchant.json",
      passkeyFile: "/work/nearpay-deploy/.secrets/accounts/merchant-passkey.json",
      stateFile: "/work/nearpay-deploy/.secrets/accounts/merchant-onboard.json",
      secretsDir: "/work/nearpay-deploy/.secrets/merchant-demo",
      webhookUrl: DEFAULT_WEBHOOK_URL,
      headed: false,
      help: false,
    });
  });

  it("takes flags over environment over defaults", () => {
    const env = {
      NP_DEPLOY_DIR: "/d",
      NP_ONBOARD_EMAIL: "Env@Shop.Test",
      NP_ONBOARD_BUSINESS: "Env Shop",
      NP_MERCHANT_KEY_FILE: "/k.json",
      NP_MERCHANT_PASSKEY_FILE: "/p/pk.json",
      NP_ONBOARD_SECRETS_DIR: "/s",
      NP_HEADED: "1",
      NP_ONBOARD_COUNTRY: "de",
      NP_KYB_MODE: "manual",
    };
    const fromEnv = parseOnboardArgs([], env, "/w");
    expect(fromEnv).toMatchObject({
      email: "env@shop.test",
      business: "Env Shop",
      deployDir: "/d",
      merchantKeyFile: "/k.json",
      passkeyFile: "/p/pk.json",
      stateFile: "/p/merchant-onboard.json",
      secretsDir: "/s",
      headed: true,
      country: "DE",
      kybMode: "manual",
    });
    const flags = parseOnboardArgs(
      [
        "--email",
        "f@x.test",
        "--business",
        "Flag Shop",
        "--country",
        "fr",
        "--kyb-mode",
        "auto",
        "--merchant-key",
        "k2.json",
        "--passkey",
        "pk2.json",
        "--state",
        "st.json",
        "--secrets-dir",
        "s2",
        "--webhook-url",
        "https://shop.example/hooks",
        "--deploy",
        "/d2",
        "--headed",
        "-h",
      ],
      env,
      "/w",
    );
    expect(flags).toStrictEqual({
      email: "f@x.test",
      business: "Flag Shop",
      country: "FR",
      kybMode: "auto",
      deployDir: "/d2",
      merchantKeyFile: "/w/k2.json",
      passkeyFile: "/w/pk2.json",
      stateFile: "/w/st.json",
      secretsDir: "/w/s2",
      webhookUrl: "https://shop.example/hooks",
      headed: true,
      help: true,
    });
  });

  it.each([
    [["--email", "nope"]],
    [["--business", "  "]],
    [["--business", "x".repeat(101)]],
    [["--webhook-url", "not a url"]],
    [["--country", "GBR"]],
    [["--kyb-mode", "review"]],
    [["--unknown"]],
    [["positional"]],
  ])("rejects %j", (argv) => {
    expect(() => parseOnboardArgs(argv, {}, "/w")).toThrow();
  });
});

describe("KYB step (open onboarding, ADR-0024)", () => {
  it("auto mode submits and waits; it never decides with the ops CLI", () => {
    for (const status of ["not_started", "needs_info", "pending", "approved", "rejected"])
      expect(kybStep(status, "auto")).not.toBe("decide");
    expect(kybStep("not_started", "auto")).toBe("submit");
    expect(kybStep("needs_info", "auto")).toBe("submit");
    expect(kybStep("pending", "auto")).toBe("wait");
    expect(kybStep("approved", "auto")).toBe("done");
    expect(kybStep("rejected", "auto")).toBe("rejected");
  });
  it("manual mode decides a pending case with the ops CLI", () => {
    expect(kybStep("pending", "manual")).toBe("decide");
    expect(kybStep("not_started", "manual")).toBe("submit");
    expect(kybStep("approved", "manual")).toBe("done");
  });
  it("declares a complete demo profile without a registration number", () => {
    const p = demoKybProfile("NearPay Demo Store", "GB");
    expect(p).toMatchObject({
      legal_name: "NearPay Demo Store",
      country_of_incorporation: "GB",
      business_address: { country: "GB" },
      representative: { name: "Demo Owner", title: "Founder" },
    });
    expect(p).not.toHaveProperty("registration_number");
  });
});
