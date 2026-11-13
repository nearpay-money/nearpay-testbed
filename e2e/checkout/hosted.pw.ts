/**
 * Full stack (step 1.4, NP_E2E=1): a payer in the browser — merchant-demo "Pay USD 2.00" → hosted
 * checkout (nearpay-checkout) in test mode → manual path ("Send from an exchange or wallet") → "Pay with":
 * network Base, token USDC, Continue → refund address → sentinel-verified merchant and destination
 * fingerprint → network confirmation reveals the address → "Simulate payment" → success redirect, and
 * the signed webhook for this very intent at merchant-demo (T2/T6 through the UI; checkout LLD §5 rules
 * 2, 8, 9). Selectors are the checkout's own test ids (its test/e2e, layout of 2026-11-12).
 */
import "../../lib/localhost-dns.js";
import { expect, test } from "@playwright/test";
import { BASE_CHAIN, choosePayWith } from "../support/checkout-ui.js";

const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
/** A checksummed Base refund address (test mode; never receives anything real). */
const REFUND = "0x52908400098527886E0F7030069857D2E4169EE7";
/**
 * Cloudflare Turnstile without the third-party script (E2E must not depend on external services):
 * the stub hands out the dummy token that Cloudflare's always-pass test sitekey produces, so payments
 * still runs siteverify with the local test secret where siteverify is reachable. Same stub as
 * nearpay-checkout's own Playwright suite.
 */
const TURNSTILE_STUB = `window.turnstile = {
  render(el, o) { setTimeout(() => o.callback("XXXX.DUMMY.TOKEN.XXXX"), 20); return "w" + Math.random(); },
  reset() {}, remove() {}
};`;

test("hosted checkout in test mode: attested merchant, simulate payment, success redirect", async ({ page }) => {
  // merchant-demo reads through Node fetch (with the *.localhost shim): Playwright's request context resolves
  // names itself and glibc does not resolve *.localhost
  const base = process.env.NP_MERCHANT_DEMO_URL ?? "https://merchant-demo.nearpay.localhost";
  const request = { get: (path: string) => fetch(`${base}${path}`) };
  test.setTimeout(180_000);
  await page.route("https://challenges.cloudflare.com/**", (r) =>
    r.fulfill({ status: 200, contentType: "text/javascript", body: TURNSTILE_STUB }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: /Pay USD 2\.00/ }).click();
  await page.waitForURL(/\/c\/cs_[0-9a-z]{26}#/);
  const sessionId = /\/c\/(cs_[0-9a-z]{26})/.exec(page.url())?.[1] as string;
  expect(sessionId).toBeTruthy();
  await expect(page.getByTestId("test-banner")).toContainText("Test mode — no real funds");
  await expect(page.getByTestId("price")).toHaveText("$2.00");

  await page.getByTestId("path-manual").click();
  await choosePayWith(page, { chain: BASE_CHAIN, method: "route_quote", asset: USDC_BASE });
  await expect(page.getByTestId("refund-form")).toBeVisible();
  await page.getByTestId("refund-address").fill(REFUND);
  await page.getByTestId("continue").click();

  // rule 2: merchant identity and fingerprint come from sentinel's verified co-signature (Stage 2 checkout:
  // shown in the "Payment details" dialog)
  await expect(page.getByTestId("manual-instructions")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("payment-details").click();
  await expect(page.getByRole("dialog", { name: "Payment details" })).toBeVisible();
  await expect(page.getByTestId("merchant-name")).not.toBeEmpty();
  await expect(page.getByTestId("fingerprint")).toHaveText(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{2}$/);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("network")).toContainText(/Base/);
  // rule 8: the address stays hidden until the payer confirms the network
  await expect(page.getByTestId("deposit-address")).toHaveCount(0);
  await page.getByTestId("confirm-network").check();
  await expect(page.getByTestId("deposit-address")).toContainText(/0x[0-9a-fA-F]{40}/);
  await expect(page.getByTestId("amount-in")).toHaveText(/USDC$/);

  await page.getByTestId("simulate").click();
  await page.waitForURL(new RegExp(`/success\\?session_id=${sessionId}`), { timeout: 120_000 });

  // the signed webhook for this session's intent reached merchant-demo (verified there)
  const order = await (await request.get(`/orders/${sessionId}`)).json();
  const pi = order.payment_intent.id as string;
  await expect
    .poll(
      async () => {
        const r = await request.get(`/events?type=payment_intent.succeeded&object=${pi}`);
        return ((await r.json()) as { data: unknown[] }).data.length;
      },
      { timeout: 60_000, intervals: [1000] },
    )
    .toBe(1);
  await expect
    .poll(async () => ((await (await request.get(`/orders/${sessionId}`)).json()) as { status: string }).status, {
      timeout: 30_000,
    })
    .toBe("complete");
});
