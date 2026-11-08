/**
 * Stage 3 scenario 1, browser half (NP_E2E=1): the customer opens the hosted invoice `/i/:id#<secret>` from the
 * `invoice.issued` link → invoice document (test banner, total incl. 19 % VAT) → "Pay" opens the invoice's checkout
 * session in place → manual path, USDC on Base → sentinel-verified merchant + fingerprint → network confirmation →
 * "Simulate payment" → "View invoice" shows it paid → the receipt PDF downloads stamped PAID; the gateway serves the
 * page with `Referrer-Policy: no-referrer` (the path names the invoice). Selectors are nearpay-checkout's test ids.
 */
import "../../lib/localhost-dns.js";
import { expect, test } from "@playwright/test";
import { md, WEBHOOK_TIMEOUT_MS } from "../support/env.js";
import { catalogue, customerMail, getInv, hostedLinkIn, sentInvoice, USDC_BASE } from "../support/stage3.js";

const REFUND = "0x52908400098527886E0F7030069857D2E4169EE7";
const TURNSTILE_STUB = `window.turnstile = {
  render(el, o) { setTimeout(() => o.callback("XXXX.DUMMY.TOKEN.XXXX"), 20); return "w" + Math.random(); },
  reset() {}, remove() {}
};`;

test("hosted invoice /i/:id: pay from Base in test mode, invoice paid, receipt PDF", async ({ page }) => {
  test.setTimeout(300_000);
  await page.route("https://challenges.cloudflare.com/**", (r) =>
    r.fulfill({ status: 200, contentType: "text/javascript", body: TURNSTILE_STUB }),
  );
  await page.route(/raw\.githubusercontent\.com|cdn\.jsdelivr\.net/, (r) =>
    r.fulfill({ contentType: "application/json", body: JSON.stringify({ wallets: [], version: "1.0.0" }) }),
  );
  const t0 = Date.now() - 2000;
  const cat = await catalogue("pw-inv");
  const inv = await sentInvoice(cat, "pw-inv");
  const link = hostedLinkIn(await customerMail(cat.email, new RegExp(`^Invoice ${inv.number} from `), t0), inv.id);

  const response = await page.goto(link);
  expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
  expect(response?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  await expect(page.getByTestId("invoice-page")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("test-banner")).toBeVisible();
  await expect(page.getByTestId("invoice-amount")).toContainText("11.90");
  await expect(page.getByTestId("invoice-lines")).toContainText("Testbed pw-inv");

  await page.getByTestId("invoice-pay").click();
  await page.getByTestId("path-manual").click({ timeout: 30_000 });
  await page.getByTestId(`option-route_quote-${USDC_BASE}`).click();
  await page.getByTestId("refund-address").fill(REFUND);
  await page.getByTestId("continue").click();
  await page.getByTestId("payment-details").click({ timeout: 30_000 });
  await expect(page.getByTestId("merchant-name")).not.toBeEmpty();
  await expect(page.getByTestId("fingerprint")).toHaveText(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{2}$/);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("deposit-address")).toHaveCount(0);
  await page.getByTestId("confirm-network").check();
  await expect(page.getByTestId("deposit-address")).toContainText(/0x[0-9a-fA-F]{40}/);
  await page.getByTestId("simulate").click();

  await page.getByTestId("view-invoice").click({ timeout: 180_000 });
  await expect(page.getByTestId("invoice-paid")).toBeVisible({ timeout: 120_000 });
  await expect.poll(async () => (await getInv(inv.id)).status, { timeout: 60_000 }).toBe("paid");
  await md().waitForEvent({ type: "invoice.paid", object: inv.id }, WEBHOOK_TIMEOUT_MS);

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("invoice-download").click()]);
  const path = await download.path();
  const { readFileSync } = await import("node:fs");
  const pdf = readFileSync(path as string).toString("latin1");
  expect(pdf.startsWith("%PDF-")).toBe(true);
  expect(pdf).toContain("(PAID)");
});
