import { createPaymentAttempt, getCheckoutSession, x402Supported } from "@nearpay/spec";
import { describe, expect, it, vi } from "vitest";
import { composeExecArgs, serviceOps } from "../../lib/compose.js";
import { ApiError, call, routeUrl } from "../../lib/http.js";
import { SCENARIOS, scenarioOf } from "../../lib/scenarios.js";
import { stackFromEnv } from "../../lib/stack.js";
import { WaitTimeout, waitFor } from "../../lib/wait.js";

describe("http", () => {
  it("builds URLs from route tables", () => {
    expect(
      routeUrl(getCheckoutSession, {
        base: "https://api.x/",
        params: { id: "cs_1" },
        query: { "expand[]": ["payment_intent"], skip: undefined },
      }),
    ).toBe("https://api.x/v1/checkout/sessions/cs_1?expand%5B%5D=payment_intent");
    expect(() => routeUrl(createPaymentAttempt, { base: "https://api.x" })).toThrow(/missing path parameter/);
  });

  it("maps error envelopes and non-JSON failures", async () => {
    const env = {
      error: {
        type: "invalid_request_error",
        code: "resource_missing",
        message: "no",
        doc_url: "https://docs.nearpay.money/errors/x",
        request_id: "req_01jbz9k3m4n5p6q7r8s9t0v1w2",
      },
    };
    const f = vi.fn(async () => new Response(JSON.stringify(env), { status: 404 }));
    await expect(
      call(x402Supported, { base: "https://api.x", fetch: f as unknown as typeof fetch, secretKey: "sk_test_x" }),
    ).rejects.toMatchObject({
      status: 404,
      code: "resource_missing",
      requestId: "req_01jbz9k3m4n5p6q7r8s9t0v1w2",
    });
    const g = vi.fn(async () => new Response("bad gateway", { status: 502, headers: { "x-request-id": "req_gw" } }));
    const e = (await call(x402Supported, { base: "https://api.x", fetch: g as unknown as typeof fetch }).catch(
      (x) => x,
    )) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.requestId).toBe("req_gw");
  });
});

describe("waitFor", () => {
  it("retries until a value, tolerating probe errors, and times out with the last error", async () => {
    let n = 0;
    const v = await waitFor(
      async () => {
        n++;
        if (n === 1) throw new Error("not yet");
        return n === 3 ? "done" : undefined;
      },
      { timeoutMs: 1000, intervalMs: 1, what: "x" },
    );
    expect(v).toBe("done");
    let t = 0;
    const p = waitFor(
      async () => {
        throw new Error("boom");
      },
      {
        timeoutMs: 10,
        what: "the thing",
        now: () => t,
        sleep: async () => {
          t += 5;
        },
      },
    );
    await expect(p).rejects.toBeInstanceOf(WaitTimeout);
    await expect(p).rejects.toThrow(/the thing \(last error: boom\)/);
  });
});

describe("compose", () => {
  it("execs ops.js in the service with up.sh's project, files and profile", () => {
    const args = composeExecArgs({ deployDir: "/d" }, "compliance-api", ["kyb-show", "acct_1"]);
    expect(args.slice(0, 5)).toStrictEqual([
      "compose",
      "--project-name",
      "nearpay",
      "--project-directory",
      "/d/compose",
    ]);
    expect(args).toContain("/d/.secrets/public/keys.env");
    expect(args.slice(args.indexOf("--profile"), args.indexOf("--profile") + 2)).toStrictEqual([
      "--profile",
      "compliance",
    ]);
    expect(args.slice(-6)).toStrictEqual([
      "-T",
      "compliance-api",
      "/nodejs/bin/node",
      "dist/ops.js",
      "kyb-show",
      "acct_1",
    ]);
  });

  it("parses JSON output", () => {
    const run = vi.fn(() => ({ code: 0, stdout: '{"engaged":false}\n', stderr: "" }));
    expect(serviceOps({ deployDir: "/d" }, "sentinel-api", ["kill-switch"], run).json).toStrictEqual({
      engaged: false,
    });
    expect(
      serviceOps({ deployDir: "/d" }, "sentinel-api", ["x"], () => ({ code: 2, stdout: "usage", stderr: "" })).json,
    ).toBeUndefined();
  });
});

describe("stack", () => {
  it("defaults to the local Compose stack and reads seeded secrets", () => {
    const s = stackFromEnv({}, "/ws/nearpay-testbed");
    expect(s).toMatchObject({
      apiUrl: "https://api.nearpay.localhost",
      payerApiUrl: "https://pay.nearpay.localhost/api",
      merchantDemoUrl: "https://merchant-demo.nearpay.localhost",
      deployDir: "/ws/nearpay-deploy",
    });
    expect(s.secretKey()).toBeNull();
    expect(() => s.pinnedKeys()).toThrow(/seed.sh keys/);
    const p = stackFromEnv({ NP_BASE_DOMAIN: "np.test", NP_HTTPS_PORT: "8443", NP_SECRET_KEY: "sk_test_1" });
    expect(p.dashboardUrl).toBe("https://dashboard.np.test:8443");
    expect(p.secretKey()).toBe("sk_test_1");
  });

  it("reads the real pinned key file when the deploy repo has one", () => {
    const s = stackFromEnv({
      NP_SENTINEL_KEYS_FILE: `${process.cwd()}/../nearpay-deploy/.secrets/public/sentinel_keys.json`,
    });
    try {
      expect(s.pinnedKeys()[0]?.kid).toMatch(/^local-/);
    } catch (e) {
      expect((e as Error).message).toMatch(/no pinned sentinel keys/);
    }
  });
});

describe("scenarios", () => {
  it("covers 00–07 with amounts whose suffix is the scenario", () => {
    expect(SCENARIOS.map((s) => s.id)).toStrictEqual(["00", "01", "02", "03", "04", "05", "06", "07"]);
    for (const s of SCENARIOS) expect(scenarioOf(s.amountCents)).toBe(s.id);
  });
});
