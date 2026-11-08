import { defineWorkspace } from "vitest/config";

// unit: pure code and mock-backed tests (merchant-demo, demos, ops, E2E support against the mock stack).
// e2e: the full-stack suites (traces T1–T7, sandbox scenarios 00–07) — step 1.4, `pnpm test:e2e`
// (NP_E2E=1 against nearpay-deploy's stack; NP_E2E=mock runs them against the mock stack).
export default defineWorkspace([
  {
    test: {
      name: "unit",
      include: ["test/**/*.test.ts"],
      pool: "forks",
      poolOptions: { forks: { singleFork: true } },
    },
  },
  {
    test: {
      name: "e2e",
      include: ["e2e/**/*.e2e.test.ts"],
      testTimeout: 600_000,
      hookTimeout: 120_000,
      pool: "forks",
      poolOptions: { forks: { singleFork: true } },
      globalSetup: ["e2e/support/global-setup.ts"],
      // *.localhost → loopback in the test workers (glibc does not resolve these names; RFC 6761)
      setupFiles: ["lib/localhost-dns.ts"],
    },
  },
]);
