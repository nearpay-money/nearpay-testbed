import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultPublicUrl, fileSecrets, readConfig } from "../../merchant-demo/src/config.js";

describe("merchant-demo config", () => {
  it("defaults to the local stack", () => {
    const c = readConfig({ NP_DEMO_SECRETS_DIR: "/nonexistent" });
    expect(c).toMatchObject({
      env: "local",
      port: 3000,
      apiBase: "https://api.nearpay.localhost",
      publicUrl: "https://merchant-demo.nearpay.localhost",
      checkoutAmount: 200,
      premiumAmount: "10000",
    });
    expect(c.secrets.secretKey()).toBeNull();
    expect(c.secrets.webhookSecrets()).toStrictEqual([]);
    expect(defaultPublicUrl("https://api.nearpay.localhost:8443/")).toBe(
      "https://merchant-demo.nearpay.localhost:8443",
    );
  });

  it("validates numbers", () => {
    expect(() => readConfig({ PORT: "x" })).toThrow(/PORT/);
    expect(() => readConfig({ NP_DEMO_CHECKOUT_AMOUNT: "1.5" })).toThrow(/CHECKOUT/);
    expect(() => readConfig({ NP_DEMO_PREMIUM_AMOUNT: "0" })).toThrow(/PREMIUM/);
  });

  it("reads secrets from files lazily (after seed.sh data) with a short cache; env wins", () => {
    const dir = mkdtempSync(join(tmpdir(), "md-"));
    let t = 0;
    const s = fileSecrets({ NP_DEMO_SECRETS_DIR: dir }, () => t);
    expect(s.secretKey()).toBeNull();
    writeFileSync(join(dir, "secret_key"), "sk_test_abc\n");
    writeFileSync(join(dir, "webhook_secret"), "whsec_a, whsec_b\n");
    expect(s.secretKey()).toBeNull(); // cached for 5 s
    t = 6_000;
    expect(s.secretKey()).toBe("sk_test_abc");
    expect(s.webhookSecrets()).toStrictEqual(["whsec_a", "whsec_b"]);
    expect(fileSecrets({ NP_DEMO_SECRETS_DIR: dir, NP_DEMO_SECRET_KEY: "sk_test_env" }).secretKey()).toBe(
      "sk_test_env",
    );
  });
});
