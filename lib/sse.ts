/**
 * A `listen`-style consumer of `GET /v1/events/stream` (webhooks §5.1, spec `streamEvents`): server-sent events over
 * fetch with the merchant key, `Last-Event-ID` resume, frames `ready` / `event` / `reset`, comment heartbeats.
 * Frames are parsed per the HTML living standard's event-stream rules (field `data` joined by newlines, `id`,
 * `event`, `retry`; lines starting with `:` are comments).
 */
import { API_VERSION, HEADERS } from "@nearpay/spec";

export interface SseFrame {
  event: string;
  id: string | null;
  data: string;
}

/** Splits an event-stream body into frames; keeps state across chunks. */
export class SseParser {
  private buf = "";
  private data: string[] = [];
  private event = "";
  private id: string | null = null;
  comments = 0;
  push(chunk: string): SseFrame[] {
    this.buf += chunk;
    const out: SseFrame[] = [];
    for (;;) {
      const nl = this.buf.search(/\r\n|\r|\n/);
      if (nl < 0) break;
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + (this.buf.startsWith("\r\n", nl) ? 2 : 1));
      if (line === "") {
        if (this.data.length || this.event)
          out.push({ event: this.event || "message", id: this.id, data: this.data.join("\n") });
        this.data = [];
        this.event = "";
        this.id = null;
        continue;
      }
      if (line.startsWith(":")) {
        this.comments++;
        continue;
      }
      const at = line.indexOf(":");
      const field = at < 0 ? line : line.slice(0, at);
      const value = at < 0 ? "" : line.slice(at + 1).replace(/^ /, "");
      if (field === "data") this.data.push(value);
      else if (field === "event") this.event = value;
      else if (field === "id") this.id = value;
    }
    return out;
  }
}

export interface StreamEvent {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  data: { object: { id?: string; object?: string; [k: string]: unknown } };
}

export interface EventStream {
  /** Frames received so far (ready/event/reset), in order. */
  readonly frames: SseFrame[];
  /** Parsed `event` frames, in order. */
  readonly events: StreamEvent[];
  readonly status: number;
  /** Waits until `pred` holds for the received events (returns them) or throws after `timeoutMs`. */
  waitFor(pred: (events: StreamEvent[]) => boolean, timeoutMs: number, what: string): Promise<StreamEvent[]>;
  close(): void;
  /** Resolves when the server closed the stream (or close() was called). */
  readonly done: Promise<void>;
}

/**
 * Opens the stream. `lastEventId` resumes after that event (the header wins over `startingAfter`). Resolves once the
 * response headers arrived (status checked by the caller via `status`).
 */
export async function openEventStream(o: {
  apiUrl: string;
  key: string;
  types?: readonly string[];
  lastEventId?: string;
  startingAfter?: string;
  fetch?: typeof fetch;
}): Promise<EventStream> {
  const ctrl = new AbortController();
  const q = new URLSearchParams();
  if (o.types?.length) q.set("types", o.types.join(","));
  if (o.startingAfter) q.set("starting_after", o.startingAfter);
  const res = await (o.fetch ?? fetch)(`${o.apiUrl.replace(/\/$/, "")}/v1/events/stream${q.size ? `?${q}` : ""}`, {
    headers: {
      accept: "text/event-stream",
      [HEADERS.authorization]: `Bearer ${o.key}`,
      [HEADERS.apiVersion]: API_VERSION,
      ...(o.lastEventId ? { "last-event-id": o.lastEventId } : {}),
    },
    signal: ctrl.signal,
  });
  const frames: SseFrame[] = [];
  const events: StreamEvent[] = [];
  const waiters = new Set<() => void>();
  const parser = new SseParser();
  const done = (async () => {
    if (!res.ok || !res.body) return;
    const decoder = new TextDecoder();
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        for (const f of parser.push(decoder.decode(chunk, { stream: true }))) {
          frames.push(f);
          if (f.event === "event") events.push(JSON.parse(f.data) as StreamEvent);
        }
        for (const w of waiters) w();
      }
    } catch {
      // aborted or connection closed
    } finally {
      for (const w of waiters) w();
    }
  })();
  return {
    frames,
    events,
    status: res.status,
    done,
    close: () => ctrl.abort(),
    waitFor(pred, timeoutMs, what) {
      return new Promise((resolveP, reject) => {
        let finished = false;
        const check = () => {
          if (finished) return;
          if (pred(events)) {
            finished = true;
            waiters.delete(check);
            clearTimeout(timer);
            resolveP(events);
          }
        };
        const timer = setTimeout(() => {
          finished = true;
          waiters.delete(check);
          reject(
            new Error(
              `events stream: timed out after ${timeoutMs} ms waiting for ${what} (got ${events.map((e) => e.type).join(", ") || "nothing"})`,
            ),
          );
        }, timeoutMs);
        waiters.add(check);
        check();
      });
    },
  };
}
