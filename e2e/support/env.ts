/**
 * E2E environment (step 1.4). Run: `pnpm test:e2e` (NP_E2E=1) after
 *   nearpay-deploy/scripts/up.sh && nearpay-deploy/scripts/seed.sh data
 * with NODE_EXTRA_CA_CERTS=../nearpay-deploy/.secrets/tls/ca.pem. Optional:
 *   NP_E2E_SLOW=1          sandbox scenarios that take minutes (01, 02, 07)
 *   NP_E2E_KYB_ACCOUNT     acct_… with a submitted KYB case (T1 ops decision)
 *   NP_AGENT_SECRET_KEY    agent key (default: the fixed test-only demo agent, see demo/agent.ts)
 */
import { serviceOps } from "../../lib/compose.js";
import { merchantDemo } from "../../lib/merchant-demo.js";
import { stackFromEnv } from "../../lib/stack.js";

export const mode = process.env.NP_E2E;
/** Any E2E run (real stack or mock). */
export const enabled = mode === "1" || mode === "mock";
/** Against nearpay-deploy's stack (traces that need real services). */
export const realStack = mode === "1";
export const slow = process.env.NP_E2E_SLOW === "1";

export const stack = () => stackFromEnv();
export const md = () => merchantDemo(stack().merchantDemoUrl);
export const payer = (url: string, sessionFromUrl: (u: string) => { sessionId: string; clientSecret: string }) => ({
  apiBase: stack().payerApiUrl,
  pinnedKeys: stack().pinnedKeys(),
  ...sessionFromUrl(url),
});
/** In-container ops CLI of a service (lld/platform.md §3). */
export const ops = (service: string, argv: string[]) => serviceOps({ deployDir: stack().deployDir }, service, argv);

/** Timeouts: sandbox success ~5 s (00) plus webhook delivery. */
export const WEBHOOK_TIMEOUT_MS = 60_000;
