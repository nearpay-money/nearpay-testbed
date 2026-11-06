/** merchant-demo in a browser against the mock stack: the shop button leads to the hosted checkout. */
import { expect, test } from "@playwright/test";

test("Pay USD 2.00 creates a session and redirects to the hosted checkout with the client secret", async ({ page }) => {
  // The hosted checkout is nearpay-checkout's (step 1.4 drives it); here we only stub its page.
  await page.route("https://pay.mock.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<h1>hosted checkout (stub)</h1>" }),
  );
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "NearPay demo shop" })).toBeVisible();
  await page.getByRole("button", { name: "Pay USD 2.00" }).click();
  await page.waitForURL(/https:\/\/pay\.mock\.test\/c\/cs_[0-9a-z]{26}#cs_[0-9a-z]{26}_secret_/);
  await expect(page.getByRole("heading", { name: "hosted checkout (stub)" })).toBeVisible();
});

test("the success page links the order", async ({ page }) => {
  await page.goto("/success?session_id=cs_01jbz9k3m4n5p6q7r8s9t0v1w2");
  await expect(page.locator("#session")).toHaveText("cs_01jbz9k3m4n5p6q7r8s9t0v1w2");
});
