/**
 * Waiting for a payout wallet (settlement destination) to be `active` — shared by the E2E suites.
 *
 * Since ADR-0027 a payout wallet is active in the same request as its attestation (and the last approval):
 * identity runs with `NP_COOLOFF_SECONDS=0` by default and `nearpay-deploy`'s `local.env.example` sets 0. Only a
 * stack whose operator sets a cool-off > 0 reports `cooling_off`; there the identity ops command
 * `destination-cooloff-skip` (NP_ENV=local) ends it. That command answers `state_conflict` (exit 1) for any other
 * status, so it is run only when the destination really is `cooling_off`.
 */
import { waitFor } from "./wait.js";

export interface SkipResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface DestinationActivation {
  /** `sd_…`, for messages. */
  id: string;
  /** The destination's current status (API read or identity `account-show`); undefined: not visible yet. */
  status(): Promise<string | undefined>;
  /** Runs identity's `destination-cooloff-skip <sd_…>` (local stacks). */
  skipCooloff(): SkipResult | Promise<SkipResult>;
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Statuses a destination never leaves by waiting (or only by a person's action): fail at once, with the status. */
const STUCK = new Set(["disabled", "pending_verification", "pending_approval"]);

/**
 * Returns once the destination is `active`. `skipped` tells whether a configured cool-off had to be ended.
 * Throws when the destination is disabled or still needs a signature or an approval, when the skip fails while
 * the destination is still cooling off, or after `timeoutMs` (default 30 s).
 */
export async function ensureDestinationActive(d: DestinationActivation): Promise<{ skipped: boolean }> {
  let skipped = false;
  const first = await d.status();
  if (first === "active") return { skipped };
  if (first === "cooling_off") {
    const r = await d.skipCooloff();
    // activated between the read and the skip (the cool-off just ended): the skip's state_conflict is fine
    if (r.code !== 0 && (await d.status()) !== "active") {
      throw new Error(`destination-cooloff-skip ${d.id} failed (exit ${r.code}): ${r.stderr || r.stdout}`);
    }
    skipped = r.code === 0;
  }
  await waitFor(
    async () => {
      const s = await d.status();
      if (s !== undefined && STUCK.has(s)) return s;
      return s === "active" ? s : undefined;
    },
    {
      timeoutMs: d.timeoutMs ?? 30_000,
      intervalMs: d.intervalMs ?? 2000,
      what: `${d.id} active`,
      ...(d.sleep ? { sleep: d.sleep } : {}),
      ...(d.now ? { now: d.now } : {}),
    },
  ).then((s) => {
    if (s !== "active") throw new Error(`${d.id} is ${s}, not active`);
  });
  return { skipped };
}

/** The status of the destination with `address` in identity's `account-show` output (ops CLI JSON). */
export function destinationInAccountShow(
  json: unknown,
  address: string,
): { id: string; status: string; livemode: boolean } | undefined {
  const list = (json as { destinations?: unknown } | null | undefined)?.destinations;
  if (!Array.isArray(list)) return undefined;
  for (const x of list as { id?: unknown; status?: unknown; address?: unknown; livemode?: unknown }[]) {
    if (x?.address === address && typeof x.id === "string" && typeof x.status === "string") {
      return { id: x.id, status: x.status, livemode: x.livemode === true };
    }
  }
  return undefined;
}
