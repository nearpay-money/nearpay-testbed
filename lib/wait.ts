/** Polling with a deadline (E2E and demo scripts wait on webhooks and state changes). */
export interface WaitOptions {
  timeoutMs: number;
  intervalMs?: number;
  /** What we wait for (error message). */
  what: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class WaitTimeout extends Error {
  constructor(what: string, timeoutMs: number, last: unknown) {
    super(
      `timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}${last instanceof Error ? ` (last error: ${last.message})` : ""}`,
    );
    this.name = "WaitTimeout";
  }
}

/** Calls `probe` until it returns a value other than `undefined`; probe errors are retried. */
export async function waitFor<T>(probe: () => Promise<T | undefined>, o: WaitOptions): Promise<T> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + o.timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await probe();
      if (v !== undefined) return v;
    } catch (e) {
      last = e;
    }
    if (now() >= deadline) throw new WaitTimeout(o.what, o.timeoutMs, last);
    await sleep(o.intervalMs ?? 1000);
  }
}
