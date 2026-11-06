/**
 * Full stack (step 1.4, NP_E2E=1): a payer in the browser — merchant-demo "Pay USD 2.00" → hosted
 * checkout (nearpay-checkout) in test mode → "Simulate payment" → success redirect, and the signed
 * webhook at merchant-demo (T2/T6 through the UI; checkout LLD §5 rules 2, 8, 9).
 */
import { expect, test } from "@playwright/test";

test("hosted checkout in test mode: attested merchant, simulate payment, success redirect", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Pay USD 2\.00/ }).click();
  await page.waitForURL(/\/c\/cs_[0-9a-z]{26}#/);
  const sessionId = /\/c\/(cs_[0-9a-z]{26})/.exec(page.url())?.[1];
  await expect(page.getByText(/test mode/i).first()).toBeVisible();
  await page
    .getByRole("button", { name: /send from anywhere|manual/i })
    .first()
    .click();
  await page.getByRole("button", { name: /USDC/ }).first().click();
  // sentinel-verified merchant name and destination fingerprint are shown before the address
  await expect(page.getByText(/[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{2}/).first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: /simulate payment/i }).click();
  await page.waitForURL(/\/success\?session_id=cs_/, { timeout: 120_000 });
  const events = await (await request.get(`/events?type=payment_intent.succeeded`)).json();
  expect(JSON.stringify(events)).toContain("payment_intent.succeeded");
  expect(sessionId).toBeTruthy();
});
