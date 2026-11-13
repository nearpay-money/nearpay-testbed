/**
 * Browser steps on the hosted checkout's "Pay with" screen (nearpay-checkout `src/features/asset-picker/PayWith.tsx`,
 * `src/ui/Picker.tsx`; the same steps as its own `test/e2e/support/pay.ts`): a network dropdown (one row per chain,
 * test id `network-<CAIP-2 chain>`), a token dropdown (rows `option-<method>-<origin asset id>`, rendered only while
 * the dropdown is open) and Continue (`asset-continue`). On the manual path Continue opens "Send from another
 * wallet" (refund address).
 */
import { expect, type Page } from "@playwright/test";

/** CAIP-2 chain of Base, as rails lists USDC on Base (`PaymentOption.chain`). */
export const BASE_CHAIN = "eip155:8453";

async function openPicker(page: Page, id: "network-picker" | "token-picker"): Promise<void> {
  const panel = page.getByTestId(`${id}-panel`);
  await expect(async () => {
    if (!(await panel.isVisible())) await page.getByTestId(`${id}-trigger`).click({ timeout: 5_000 });
    await expect(panel).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

/** Picks the option's network, then its token, then Continue — what a payer does with the mouse. */
export async function choosePayWith(
  page: Page,
  o: { chain: string; method: "route_quote" | "intents_transfer"; asset: string },
): Promise<void> {
  await expect(page.getByTestId("asset-picker")).toBeVisible({ timeout: 30_000 });
  await openPicker(page, "network-picker");
  await page.getByTestId(`network-${o.chain}`).click();
  await expect(page.getByTestId("network-picker-panel")).toHaveCount(0);
  await openPicker(page, "token-picker");
  await page.getByTestId(`option-${o.method}-${o.asset}`).click();
  await expect(page.getByTestId("token-picker-panel")).toHaveCount(0);
  await page.getByTestId("asset-continue").click();
}
