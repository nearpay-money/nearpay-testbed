import { describe, expect, it } from "vitest";
import { destinationInAccountShow, ensureDestinationActive } from "../../lib/destinations.js";

/** A destination whose status follows `script` (the last entry repeats). */
function scripted(script: (string | undefined)[], skip = { code: 0, stdout: "{}", stderr: "" }) {
  let reads = 0;
  let skips = 0;
  let clock = 0;
  return {
    d: {
      id: "sd_x",
      status: async () => script[Math.min(reads++, script.length - 1)],
      skipCooloff: () => {
        skips++;
        return skip;
      },
      timeoutMs: 10_000,
      intervalMs: 1000,
      sleep: async (ms: number) => {
        clock += ms;
      },
      now: () => clock,
    },
    skips: () => skips,
    reads: () => reads,
  };
}

describe("ensureDestinationActive", () => {
  it("no cool-off (ADR-0027): an active destination needs no skip and no wait", async () => {
    const s = scripted(["active"]);
    expect(await ensureDestinationActive(s.d)).toStrictEqual({ skipped: false });
    expect(s.skips()).toBe(0);
    expect(s.reads()).toBe(1);
  });

  it("a configured cool-off: skips once, then waits for the activation job", async () => {
    const s = scripted(["cooling_off", "cooling_off", "cooling_off", "active"]);
    expect(await ensureDestinationActive(s.d)).toStrictEqual({ skipped: true });
    expect(s.skips()).toBe(1);
  });

  it("never runs the skip for a status other than cooling_off (identity answers state_conflict)", async () => {
    const s = scripted([undefined, "active"]);
    expect(await ensureDestinationActive(s.d)).toStrictEqual({ skipped: false });
    expect(s.skips()).toBe(0);
  });

  it("a skip that fails while the destination is still cooling off is an error", async () => {
    const s = scripted(["cooling_off"], { code: 1, stdout: "", stderr: '{"error":{"code":"state_conflict"}}' });
    await expect(ensureDestinationActive(s.d)).rejects.toThrow(/destination-cooloff-skip sd_x failed \(exit 1\)/);
  });

  it("a skip that lost the race with the activation is fine", async () => {
    const s = scripted(["cooling_off", "active"], { code: 1, stdout: "state_conflict", stderr: "" });
    expect(await ensureDestinationActive(s.d)).toStrictEqual({ skipped: false });
  });

  it("fails at once for a destination that waiting cannot activate", async () => {
    for (const status of ["disabled", "pending_verification", "pending_approval"]) {
      const s = scripted([status]);
      await expect(ensureDestinationActive(s.d)).rejects.toThrow(`sd_x is ${status}, not active`);
      expect(s.skips()).toBe(0);
    }
  });

  it("times out when the destination never activates", async () => {
    const s = scripted(["cooling_off"]);
    await expect(ensureDestinationActive(s.d)).rejects.toThrow(/timed out after 10 s waiting for sd_x active/);
  });

  it("uses the default timeout and interval", async () => {
    let reads = 0;
    const r = await ensureDestinationActive({
      id: "sd_y",
      status: async () => (reads++ === 0 ? undefined : "active"),
      skipCooloff: () => ({ code: 0, stdout: "", stderr: "" }),
    });
    expect(r.skipped).toBe(false);
  });
});

describe("destinationInAccountShow", () => {
  const json = {
    id: "acct_1",
    destinations: [
      { id: "sd_test", livemode: false, status: "active", address: "other.near" },
      { id: "sd_live", livemode: true, status: "cooling_off", address: "abc123" },
      { id: 7, status: "active", address: "broken" },
    ],
  };

  it("finds the destination by address", () => {
    expect(destinationInAccountShow(json, "abc123")).toStrictEqual({
      id: "sd_live",
      status: "cooling_off",
      livemode: true,
    });
    expect(destinationInAccountShow(json, "other.near")?.livemode).toBe(false);
  });

  it("answers undefined for unknown addresses, malformed rows and missing output", () => {
    expect(destinationInAccountShow(json, "nope")).toBeUndefined();
    expect(destinationInAccountShow(json, "broken")).toBeUndefined();
    expect(destinationInAccountShow(undefined, "abc123")).toBeUndefined();
    expect(destinationInAccountShow({ destinations: "x" }, "abc123")).toBeUndefined();
  });
});
