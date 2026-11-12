/**
 * T1 — merchant onboarding through the real dashboard (lld/audits/system.md §3, NP_E2E=1):
 * passkey sign-up (Turnstile) → magic link from Mailpit (notify) → passkey registration (CDP virtual
 * authenticator, like nearpay-dashboard's own suite) → live payout wallet (NEAR Intents account) → NEP-413
 * attestation signed by a real key of a fresh implicit account (identity §8.2: hex(pubkey) == address,
 * no RPC) → the wallet is active at once ("Payout wallet active"; ADR-0027: `NP_COOLOFF_SECONDS=0` is
 * identity's default and what nearpay-deploy's local.env.example sets) → `activated` (security email) →
 * business details saved (no registration number) → compliance decides at once (NP_KYB_MODE=auto,
 * ADR-0024; no ops step) → account live. A stack whose operator sets a cool-off > 0 shows the wallet as
 * "Activating"; only then the trace ends the cool-off with the ops CLI (`destination-cooloff-skip`, which
 * identity refuses for any other status). With NP_KYB_MODE=manual on the stack, the trace keeps the Stage 1
 * ops CLI decision.
 *
 * Selectors follow nearpay-dashboard's own suite (test/e2e/onboarding.spec.ts, src/features/kyb/kyb.e2e.ts)
 * after the 2026-11-12 redesign: "Payout wallets" instead of "destinations", a Live / Test radio group.
 */
import "../../lib/localhost-dns.js";
import { randomBytes } from "node:crypto";
import { nep413Hash } from "@nearpay-money/agent-signer";
import { ed25519 } from "@noble/curves/ed25519.js";
import { expect, type Page, test } from "@playwright/test";
import { serviceOps } from "../../lib/compose.js";
import { destinationInAccountShow, ensureDestinationActive } from "../../lib/destinations.js";
import { stackFromEnv } from "../../lib/stack.js";
import { runCli } from "../../ops/cli.js";

const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const TURNSTILE_STUB = `window.turnstile = {
  render(el, o) { setTimeout(() => o.callback("XXXX.DUMMY.TOKEN.XXXX"), 20); return "w" + Math.random(); },
  reset() {}, remove() {}
};`;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

const st = stackFromEnv();
const mailUrl = st.dashboardUrl.replace("://dashboard.", "://mail.");
const ops = (service: string, argv: string[]) => serviceOps({ deployDir: st.deployDir }, service, argv);

/** Newest Mailpit message to `to` whose subject matches, as plain text. */
async function mail(_page: Page, to: string, subject: RegExp): Promise<{ subject: string; text: string }> {
  let found: { subject: string; text: string } | undefined;
  await expect
    .poll(
      async () => {
        // Node fetch (with the *.localhost shim): Playwright's request context resolves names itself
        const r = await fetch(`${mailUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
        const list = (await r.json()) as { messages: { ID: string; Subject: string }[] };
        const m = list.messages.find((x) => subject.test(x.Subject));
        if (!m) return false;
        const full = (await (await fetch(`${mailUrl}/api/v1/message/${m.ID}`)).json()) as { Text: string };
        found = { subject: m.Subject, text: full.Text };
        return true;
      },
      { timeout: 60_000, intervals: [1000] },
    )
    .toBe(true);
  return found as { subject: string; text: string };
}

async function setUp(page: Page, near: { accountId: string; publicKey: string; secret: Uint8Array }) {
  // no third-party scripts in E2E: Turnstile stub (dummy token of the always-pass test sitekey) and
  // an empty NEAR Connect manifest, so only the injected test wallet is offered
  await page.route("https://challenges.cloudflare.com/**", (r) =>
    r.fulfill({ status: 200, contentType: "text/javascript", body: TURNSTILE_STUB }),
  );
  await page.route(/raw\.githubusercontent\.com|cdn\.jsdelivr\.net/, (r) =>
    r.fulfill({ contentType: "application/json", body: JSON.stringify({ wallets: [], version: "1.0.0" }) }),
  );
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  // the NEAR wallet signs NEP-413 in Node with the implicit account's real key
  await page.exposeFunction("__npNearSign", (message: string, recipient: string, nonceB64: string) => {
    const hash = nep413Hash(message, Uint8Array.from(Buffer.from(nonceB64, "base64")), recipient);
    return Buffer.from(ed25519.sign(hash, near.secret)).toString("base64");
  });
  await page.addInitScript(
    ({ accountId, publicKey }) => {
      const sign = (window as unknown as { __npNearSign: (m: string, r: string, n: string) => Promise<string> })
        .__npNearSign;
      const account = { accountId, publicKey };
      const wallet = {
        manifest: {
          id: "test-near-wallet",
          name: "Test NEAR Wallet",
          icon: "",
          website: "https://wallet.test",
          description: "test",
          version: "1.0.0",
          type: "injected",
          platform: {},
          permissions: {},
          features: {
            signMessage: true,
            signTransaction: false,
            signAndSendTransaction: false,
            signAndSendTransactions: false,
            signInWithoutAddKey: true,
            mainnet: true,
            testnet: true,
          },
        },
        signIn: async () => [account],
        signInAndSignMessage: async () => [],
        signOut: async () => {},
        getAccounts: async () => [account],
        signMessage: async (p: { message: string; recipient: string; nonce: Uint8Array }) => ({
          accountId,
          publicKey,
          signature: await sign(p.message, p.recipient, btoa(String.fromCharCode(...p.nonce))),
        }),
        signAndSendTransaction: async () => ({}),
        signAndSendTransactions: async () => [],
        signDelegateActions: async () => ({}),
      };
      window.addEventListener("near-selector-ready", () => {
        window.dispatchEvent(new CustomEvent("near-wallet-injected", { detail: wallet }));
      });
    },
    { accountId: near.accountId, publicKey: near.publicKey },
  );
}

test("T1 onboarding: sign-up, magic link, passkey, live payout wallet with NEP-413, active, KYB → live", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const secret = randomBytes(32);
  const pub = ed25519.getPublicKey(secret);
  const near = { accountId: Buffer.from(pub).toString("hex"), publicKey: `ed25519:${base58(pub)}`, secret };
  const email = `t1-${Date.now()}@merchant.test`;
  const business = `T1 Coffee ${Date.now() % 100_000}`;
  await setUp(page, near);

  // sign-up → magic link (notify → Mailpit), token only in the fragment
  await page.goto(`${st.dashboardUrl}/signup`);
  await page.getByLabel("Work email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-up link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  const signup = await mail(page, email, /.*/);
  const link = new RegExp(`${st.dashboardUrl.replace(/[.]/g, "\\.")}/auth/verify#token=[A-Za-z0-9_-]+`).exec(
    signup.text,
  )?.[0];
  expect(link, `magic link in "${signup.subject}"`).toBeTruthy();

  // passkey registration creates user + account (owner) + session
  await page.goto(link as string);
  await expect(page.getByText("Email verified")).toBeVisible({ timeout: 30_000 });
  expect(page.url()).not.toContain("token=");
  await page.getByLabel("Business name").fill(business);
  await page.getByRole("button", { name: "Create passkey and open dashboard" }).click();
  await expect(page.getByTestId("account-name")).toHaveText(business, { timeout: 30_000 });
  const shown = ops("identity-api", ["account-show", email]);
  expect(shown.code, shown.stderr).toBe(0);
  const account = /"(acct_[0-9a-z]{26})"/.exec(JSON.stringify(shown.json))?.[1] as string;
  expect(account).toBeTruthy();

  // live payout wallet: NEP-413 challenge signed by the wallet account's key (mode switch = Live / Test radio
  // group, "Add a payout wallet" form, wallet verification in one step)
  await page.getByTestId("mode-switch").getByRole("radio", { name: "Live", exact: true }).click();
  await expect(page).toHaveURL(/mode=live/);
  await page.goto(`${st.dashboardUrl}/settlement/new?mode=live`);
  await expect(page.getByRole("heading", { name: "Add a payout wallet" })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("Wallet name").fill("Live USDC (T1)");
  await page.getByLabel("Currency").selectOption("USDC");
  await page.getByLabel("Network", { exact: true }).selectOption(USDC_NEAR);
  await page.getByLabel("NEAR Intents account", { exact: true }).fill(near.accountId);
  await page.getByRole("button", { name: "Connect wallet & verify" }).click();
  const stepUp = page.getByRole("dialog", { name: "Confirm it's you" });
  const challenge = page.getByTestId("challenge-message");
  await expect(stepUp.or(challenge)).toBeVisible({ timeout: 30_000 });
  if (await stepUp.isVisible()) await page.getByRole("button", { name: "Confirm with passkey" }).click();
  await expect(challenge).toContainText(`Address: ${near.accountId}`, { timeout: 30_000 });
  await expect(challenge).toContainText(`Account: ${account}`);
  await page.getByRole("button", { name: "Connect NEAR wallet" }).click();
  await page.locator('.connect-item[data-type="test-near-wallet"]').click();
  // the signature verified: "Payout wallet active" (no cool-off, the default) or, on a stack with a cool-off,
  // "Signature verified." with the activating line
  const activeNote = page.getByText("Payout wallet active", { exact: true });
  const activatingNote = page.getByText("Activating. It can receive payments once it shows as active.");
  await expect(activeNote.or(activatingNote)).toBeVisible({ timeout: 30_000 });
  const fingerprint = (await page
    .getByText(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{2}$/)
    .first()
    .textContent()) as string;

  // identity's view of the wallet: active at once without a cool-off; with one, the ops CLI ends it
  const destinationNow = () =>
    destinationInAccountShow(ops("identity-api", ["account-show", account]).json, near.accountId);
  const dest = destinationNow();
  expect(dest, `live destination ${near.accountId} in account-show`).toBeTruthy();
  const destination = (dest as { id: string }).id;
  expect(dest).toMatchObject({ livemode: true });
  const cooling = dest?.status === "cooling_off";
  if (cooling) await expect(activatingNote).toBeVisible();
  else {
    expect(dest?.status).toBe("active");
    await expect(activeNote).toBeVisible();
    await expect(page.getByText("Signature verified. Live payments can settle to this wallet now.")).toBeVisible();
  }
  const { skipped } = await ensureDestinationActive({
    id: destination,
    status: async () => destinationNow()?.status,
    skipCooloff: () => ({
      code: runCli(["destination-cooloff-skip", destination], { deployDir: st.deployDir, out: () => {} }),
      stdout: "",
      stderr: "see the ops CLI output above",
    }),
    timeoutMs: 60_000,
  });
  expect(skipped).toBe(cooling);

  // the payout wallets list shows it as Active (status badge), with the same fingerprint
  await page.getByRole("link", { name: "Back to payout wallets" }).click();
  await expect(page.getByRole("heading", { name: "Payout wallets", exact: true })).toBeVisible();
  const row = page
    .getByTestId("destinations-table")
    .locator("tr", { has: page.getByTestId(`destination-${destination}`) });
  await expect(async () => {
    if (!(await row.getByText("Active", { exact: true }).isVisible())) await page.reload();
    await expect(row.getByText("Active", { exact: true })).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  await expect(row.getByTestId("activating")).toHaveCount(0);
  await expect(row).toContainText("Live USDC (T1)");
  await expect(row).toContainText(fingerprint);
  await mail(page, email, /settlement destination is now active/i); // notify's security email on activation

  // self-declared business details (Settings → Business details, ADR-0020 d3) → automatic decision
  // (open onboarding, ADR-0024) → identity live_enabled. Manual review mode keeps the ops CLI decision.
  await page.goto(`${st.dashboardUrl}/settings/business`);
  await page.getByLabel("Registered legal name").fill(`${business} GmbH`);
  await page.getByLabel("Country of incorporation").selectOption("DE");
  await page.getByLabel("Business type").selectOption("company");
  await page.getByLabel("Expected monthly volume").selectOption("under_10k");
  await page.getByLabel("Street address").fill("Teststr. 1");
  await page.getByLabel("City").fill("Berlin");
  await page.getByLabel("Postal code").fill("10115");
  await page.getByLabel(/^Country(?! of)/).selectOption("DE");
  await page.getByLabel("Full name").fill("Erika Mustermann");
  await page.getByLabel("Role").fill("Director");
  await page.getByTestId("kyb-declaration").check();
  await page.getByTestId("kyb-submit").click();
  // submitKyb needs a fresh step-up: the dialog appears unless the wallet step's confirmation still holds (10 min)
  const kybStatus = page.getByTestId("kyb-status");
  await expect(stepUp.or(kybStatus)).toBeVisible({ timeout: 30_000 });
  if (await stepUp.isVisible()) await page.getByRole("button", { name: "Confirm with passkey" }).click();
  if (process.env.NP_KYB_MODE === "manual") {
    await expect
      .poll(() => JSON.stringify(ops("compliance-api", ["kyb-show", account]).json), { timeout: 30_000 })
      .toMatch(/"status":\s*"pending"/);
    expect(
      runCli(["kyb-decide", account, "approved", "--reason", "testbed T1"], { deployDir: st.deployDir, out: () => {} }),
    ).toBe(0);
  } else {
    await expect(kybStatus).toContainText("You're live — you can accept real payments", { timeout: 30_000 });
    const kyb = JSON.stringify(ops("compliance-api", ["kyb-show", account]).json);
    expect(kyb).toMatch(/"status":\s*"approved"/);
    expect(kyb).toMatch(/"decided_by":\s*"system"/);
  }
  await expect
    .poll(() => JSON.stringify(ops("identity-api", ["account-show", account]).json), { timeout: 60_000 })
    .toMatch(/"live_enabled":\s*true/);
  expect(JSON.stringify(ops("identity-api", ["account-show", account]).json)).toMatch(/"kyb_status":\s*"approved"/);
});
