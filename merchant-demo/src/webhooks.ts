/**
 * Webhook receiver (api-conventions §9, lld/webhooks.md §6): `@nearpay/node` `constructEvent` verifies
 * `NearPay-Signature` v1 (HMAC-SHA256 over `<t>.<raw body>`, any v1 value, constant time, 300 s) on the
 * raw body bytes; the event is then kept (deduplicated by id) for the demo page and the demo scripts.
 */
import { constructEvent } from "@nearpay/node";
import { EventEnvelopeLoose, type z } from "@nearpay/spec";

export type WebhookEvent = z.output<typeof EventEnvelopeLoose>;

export type VerifyFailure = "missing_header" | "signature_invalid" | "invalid_body";

export type VerifyResult = { ok: true; event: WebhookEvent } | { ok: false; reason: VerifyFailure; detail?: string };

export function verifyWebhook(
  rawBody: Buffer | string,
  header: string | undefined,
  secrets: readonly string[],
  opts: { now?: number; toleranceSec?: number } = {},
): VerifyResult {
  if (!header) return { ok: false, reason: "missing_header" };
  if (secrets.length === 0) return { ok: false, reason: "signature_invalid", detail: "no webhook secret configured" };
  try {
    constructEvent(rawBody, header, secrets, {
      ...(opts.now !== undefined ? { now: Math.floor(opts.now / 1000) } : {}),
      ...(opts.toleranceSec !== undefined ? { toleranceSec: opts.toleranceSec } : {}),
    });
  } catch (e) {
    return { ok: false, reason: "signature_invalid", detail: (e as Error).message };
  }
  let json: unknown;
  try {
    json = JSON.parse(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid_body" };
  }
  const event = EventEnvelopeLoose.safeParse(json);
  return event.success ? { ok: true, event: event.data } : { ok: false, reason: "invalid_body" };
}

export interface StoredEvent {
  id: string;
  type: string;
  livemode: boolean;
  created: number;
  object_id: string | null;
  received_at: number;
  event: WebhookEvent;
}

/** Recent verified events, newest first; deliveries are at-least-once, so ids are deduplicated. */
export class EventStore {
  private readonly events: StoredEvent[] = [];
  constructor(private readonly max = 500) {}

  /** Returns false for a duplicate delivery. */
  add(event: WebhookEvent, receivedAt = Date.now()): boolean {
    if (this.events.some((e) => e.id === event.id)) return false;
    const objectId = typeof event.data.object.id === "string" ? event.data.object.id : null;
    this.events.unshift({
      id: event.id,
      type: event.type,
      livemode: event.livemode,
      created: event.created,
      object_id: objectId,
      received_at: receivedAt,
      event,
    });
    this.events.length = Math.min(this.events.length, this.max);
    return true;
  }

  list(filter: { type?: string; object?: string } = {}): StoredEvent[] {
    return this.events.filter(
      (e) => (!filter.type || e.type === filter.type) && (!filter.object || e.object_id === filter.object),
    );
  }
}
