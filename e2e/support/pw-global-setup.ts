/**
 * Playwright global setup of the full-stack project (`NP_E2E=1 pnpm test:pw`): the same stack preparation as the
 * Vitest suites (global-setup.ts) — an offline stack gets the synthetic OFAC list, without which compliance answers
 * the live payout wallet of T1 with `screening_unavailable`. The browser suites can then run on their own, before
 * `pnpm test:e2e` was ever run on the stack.
 */
import { setup } from "./global-setup.js";

export default async function globalSetup(): Promise<void> {
  await setup();
}
