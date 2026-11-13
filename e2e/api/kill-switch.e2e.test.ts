/**
 * T7 — kill switch: a spoofed co-signing request is refused without engaging anything (L-SN-01);
 * an operator drill engages it → `evt.sentinel.kill_switch.engaged` → rails stops live quoting and
 * agentpay pauses live x402 settles and checkout relays (agentpay §8); the Stage 1 ops CLI release
 * resumes both. Real stack only (in-container ops CLIs via docker compose exec).
 *
 * ADR-0028 (2026-11-12) changed what sentinel does by itself — one integrity breach quarantines that
 * merchant only, the switch engages only on corroborated breaches across merchants, and a stale automatic
 * stop releases itself — but not this trace: a bad ticket is refused before any check (`ticket_invalid`),
 * and an operator's engagement (actor `cli@<host>`, not `sentinel`) is never released automatically, so it
 * stays engaged until the release below (single-person CLI release: NP_ENV local/test only).
 */
import { createDepositInstructionsAttestation } from "@nearpay-money/spec";
import { afterAll, describe, expect, it } from "vitest";
import { ApiError, call } from "../../lib/http.js";
import { waitFor } from "../../lib/wait.js";
import { ops, realStack, stack } from "../support/env.js";

/** sentinel `ops.js kill-switch` prints `{engaged, reason, actor, …, log: [last 20 changes]}`: the state is the top level. */
const switchEngaged = (): boolean | undefined =>
  (ops("sentinel-api", ["kill-switch"]).json as { engaged?: boolean } | undefined)?.engaged;

/** rails `ops.js flags` prints `[{name, value, reason, …}]`. */
const quoting = (): boolean | undefined => {
  const f = ops("rails-api", ["flags"]).json as { name: string; value: boolean }[] | undefined;
  return f?.find((x) => x.name === "quoting_enabled")?.value;
};

/** agentpay `ops.js kill-switch` prints `{kill_switch: {engaged, reason, …}}`. */
const agentpayPaused = (): boolean | undefined =>
  (ops("agentpay-api", ["kill-switch"]).json as { kill_switch?: { engaged: boolean } } | undefined)?.kill_switch
    ?.engaged;

describe.skipIf(!realStack)("T7 kill switch", () => {
  afterAll(() => {
    // never leave the local stack with live quoting stopped
    ops("sentinel-api", ["kill-switch-release", "testbed e2e cleanup"]);
  });

  it("refuses a spoofed request (bad ticket) and does not engage", async () => {
    const err = await call(createDepositInstructionsAttestation, {
      base: stack().apiUrl,
      body: {
        livemode: true,
        kind: "route_quote",
        attempt_id: "pa_01jbz9k3m4n5p6q7r8s9t0v1w2",
        attestation_ticket: "e30.c2ln",
        deposit: {
          address: "0x0000000000000000000000000000000000000bad",
          memo: null,
          chain: "eip155:8453",
          origin_asset_id: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
          amount_in: "1",
          deadline: new Date(Date.now() + 600_000).toISOString(),
        },
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("ticket_invalid");
    // the switch itself, not a `kill_switch_log` row of an earlier release
    expect(switchEngaged()).toBe(false);
  });

  it("engage (drill) stops live quoting; the ops CLI release resumes it", async () => {
    expect(ops("sentinel-api", ["kill-switch-engage", "testbed e2e drill"]).code).toBe(0);
    expect(switchEngaged()).toBe(true);
    await waitFor(async () => (quoting() === false ? true : undefined), {
      timeoutMs: 30_000,
      what: "rails quoting_enabled=false",
    });
    await waitFor(async () => (agentpayPaused() === true ? true : undefined), {
      timeoutMs: 30_000,
      what: "agentpay kill switch engaged",
    });
    const { runCli } = await import("../../ops/cli.js");
    expect(
      runCli(["kill-switch-release", "testbed", "e2e", "drill", "done", "--yes"], {
        deployDir: stack().deployDir,
        out: () => {},
      }),
    ).toBe(0);
    expect(switchEngaged()).toBe(false);
    await waitFor(async () => (quoting() === true ? true : undefined), {
      timeoutMs: 30_000,
      what: "rails quoting_enabled=true",
    });
    await waitFor(async () => (agentpayPaused() === false ? true : undefined), {
      timeoutMs: 30_000,
      what: "agentpay kill switch released",
    });
  });
});
