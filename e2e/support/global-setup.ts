/**
 * E2E global setup. `NP_E2E=1`: the nearpay-deploy stack (scripts/up.sh + seed.sh data) must be up.
 * `NP_E2E=mock`: starts the mock stack and an in-process merchant-demo, so the suites' own logic can
 * be exercised before step 1.4 (scenario 00 only; traces that need real services are skipped).
 */
import type { MockStack } from "../../test/support/mock-stack.js";

let stop: (() => Promise<void>) | null = null;

export async function setup(): Promise<void> {
  if (process.env.NP_E2E === "1") return stackSetup();
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

/**
 * Real stack: compliance answers live screening (live destinations, Stage 2 console smoke) with
 * `screening_unavailable` until an OFAC list was loaded once; offline machines cannot download it, so the
 * synthetic list (fixtures/ofac, not OFAC data) is imported when the stack has none.
 */
async function stackSetup(): Promise<void> {
  const { serviceOps } = await import("../../lib/compose.js");
  const { stackFromEnv } = await import("../../lib/stack.js");
  const { SYNTHETIC_SDN } = await import("../../ops/cli.js");
  const { readFileSync } = await import("node:fs");
  const t = { deployDir: stackFromEnv().deployDir };
  const status = serviceOps(t, "compliance-api", ["sanctions-status"]);
  if (status.code !== 0) return; // compliance not running: the suites that need it fail with their own reason
  if (((status.json as { entries?: number } | undefined)?.entries ?? 0) > 0) return;
  const r = serviceOps(t, "compliance-api", ["sanctions-import", "-"], undefined, readFileSync(SYNTHETIC_SDN, "utf8"));
  if (r.code !== 0) throw new Error(`sanctions-import failed: ${r.stderr}`);
}
