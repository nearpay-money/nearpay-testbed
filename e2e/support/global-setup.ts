/**
 * E2E global setup. `NP_E2E=1`: the nearpay-deploy stack (scripts/up.sh + seed.sh data) must be up.
 * `NP_E2E=mock`: starts the mock stack and an in-process merchant-demo, so the suites' own logic can
 * be exercised before step 1.4 (scenario 00 only; traces that need real services are skipped).
 */
import type { MockStack } from "../../test/support/mock-stack.js";

let stop: (() => Promise<void>) | null = null;

export async function setup(): Promise<void> {
  if (process.env.NP_E2E !== "mock") return;
  const { startMockStack, startMerchantDemo, SECRET_KEY, SENTINEL_KEY } = await import(
    "../../test/support/mock-stack.js"
  );
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const stack: MockStack = await startMockStack();
  const demo = await startMerchantDemo(stack);
  const keys = join(mkdtempSync(join(tmpdir(), "np-e2e-")), "sentinel_keys.json");
  writeFileSync(keys, JSON.stringify([SENTINEL_KEY]));
  Object.assign(process.env, {
    NP_API_URL: stack.url,
    NP_PAYER_API_URL: stack.url,
    NP_PAY_URL: stack.payUrl,
    NP_MERCHANT_DEMO_URL: demo.url,
    NP_SECRET_KEY: SECRET_KEY,
    NP_SENTINEL_KEYS_FILE: keys,
  });
  stop = async () => {
    await demo.close();
    await stack.close();
  };
}

export async function teardown(): Promise<void> {
  await stop?.();
}
