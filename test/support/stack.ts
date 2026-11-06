import type { Stack } from "../../lib/stack.js";
import { type MockStack, SECRET_KEY, SENTINEL_KEY } from "./mock-stack.js";

/** A `Stack` pointing at the mock stack and an in-process merchant-demo. */
export function mockStackConfig(stack: MockStack, merchantDemoUrl: string): Stack {
  return {
    baseDomain: "mock",
    apiUrl: stack.url,
    payUrl: stack.payUrl,
    payerApiUrl: stack.url,
    dashboardUrl: `${stack.url}/dashboard`,
    merchantDemoUrl,
    deployDir: "/nonexistent",
    secretKey: () => SECRET_KEY,
    pinnedKeys: () => [SENTINEL_KEY],
  };
}
