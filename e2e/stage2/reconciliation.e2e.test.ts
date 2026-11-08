/**
 * Stage 2 scenario 3 — daily reconciliation through the console (lld/payments.md §6.4, §9 `reconcile.daily`,
 * RB-05): an operator re-runs the demo merchant's last completed UTC day on `ops.<domain>/api/ops/
 * reconciliation_runs` → `ok`, `diff_count: 0`. Then a discrepancy is injected: rails (the evidence side) is
 * stopped while a run executes, so the run cannot reconcile and ends `error` after its retries — which, like a
 * `diff`, opens a `reconciliation_diff` compliance case in the console queue.
 *
 * Why not a `diff` with mismatching amounts: only completed UTC days can be reconciled (`reconciliation_day_open`
 * for today) and the testbed never writes service databases, so a fresh stack has no settled activity on a
 * completed day to disagree about. Set NP_E2E_RECON_DAY=<YYYY-MM-DD> to also reconcile a day with activity.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OpsConsole } from "../../lib/ops-console.js";
import { opsRoute } from "../../lib/ops-console.js";
import { realStack, stack } from "../support/env.js";
import { operator, until } from "../support/stage2.js";

type Run = {
  id: string;
  status: string;
  diff_count: number;
  day: string;
  error: string | null;
  rerun_of: string | null;
};

const demoAccount = () =>
  (JSON.parse(readFileSync(join(stack().deployDir, ".secrets/demo.json"), "utf8")) as { account: string }).account;
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

async function reconcile(op: OpsConsole, account: string, day: string): Promise<Run> {
  const run = await op.call<Run>(opsRoute("createOpsReconciliationRun"), {
    body: { account_id: account, livemode: false, day },
  });
  expect(run).toMatchObject({ day, status: "running" });
  return until(
    () => op.call<Run>(opsRoute("getOpsReconciliationRun"), { params: { id: run.id } }),
    (r) => r.status !== "running",
    3 * 60_000,
    `${run.id} completed`,
  );
}

const compose = (args: string[]) => {
  const d = join(stack().deployDir, "compose");
  return spawnSync("docker", ["compose", "-p", "nearpay", "--project-directory", d, ...args], { encoding: "utf8" });
};

describe.skipIf(!realStack)("Stage 2 · reconciliation (console)", () => {
  it("a completed day reconciles ok with no diffs; today is refused", async () => {
    const op = await operator("ops", "recon");
    const account = demoAccount();
    for (const day of [yesterday(), ...(process.env.NP_E2E_RECON_DAY ? [process.env.NP_E2E_RECON_DAY] : [])]) {
      const run = await reconcile(op, account, day);
      expect(run, JSON.stringify(run)).toMatchObject({ status: "ok", diff_count: 0, error: null });
    }
    await expect(
      op.call(opsRoute("createOpsReconciliationRun"), {
        body: { account_id: account, livemode: false, day: new Date().toISOString().slice(0, 10) },
      }),
    ).rejects.toMatchObject({ status: 422, code: "reconciliation_day_open" });
  });

  it("an injected discrepancy (evidence unavailable) ends the run in error and opens a reconciliation_diff case", async () => {
    const op = await operator("ops", "recon");
    const account = demoAccount();
    const stop = compose(["stop", "rails-api"]);
    expect(stop.status, stop.stderr).toBe(0);
    let run: Run;
    try {
      run = await reconcile(op, account, yesterday());
    } finally {
      const start = compose(["start", "rails-api"]);
      expect(start.status, start.stderr).toBe(0);
    }
    expect(run).toMatchObject({ status: "error" });
    expect(run.error).toMatch(/could not complete/);
    const cases = await until(
      () =>
        op.call<{ data: { kind: string; subject: { type: string; id: string }; status: string }[] }>(
          opsRoute("listOpsCases"),
          { query: { kind: "reconciliation_diff", limit: "100" } },
        ),
      (l) => l.data.some((c) => c.subject.id === run.id),
      60_000,
      `reconciliation_diff case for ${run.id}`,
    );
    expect(cases.data.find((c) => c.subject.id === run.id)).toMatchObject({
      kind: "reconciliation_diff",
      subject: { type: "reconciliation_run" },
      status: "open",
    });
    // rails is back before the next suite (wait for its health)
    await until(
      async () => compose(["ps", "--format", "{{.Status}}", "rails-api"]).stdout,
      (s) => /healthy/.test(s) && !/unhealthy|starting/.test(s),
      90_000,
      "rails-api healthy",
    );
  });
});
