import { defineConfig } from "vitest/config";

// Coverage gate on the code the demos, E2E suites and ops rely on (foundations §16).
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["lib/**/*.ts", "merchant-demo/src/**/*.ts", "ops/**/*.ts", "demo/**/*.ts"],
      exclude: ["merchant-demo/src/main.ts"],
      reporter: ["text", "json-summary"],
      thresholds: { branches: 80, lines: 90 },
    },
  },
});
