/**
 * Webhook receiver (api-conventions §9, lld/webhooks.md §6): verifies `NearPay-Signature` v1
 * (HMAC-SHA256 over `<t>.<raw body>` with the endpoint secret, any of several v1 values, constant-time,
 * 300 s tolerance) on the raw body bytes, then keeps the event (deduplicated by id) for the demo page
 * and the demo scripts.
 *
 * TODO(step 1.4): switch to `@nearpay/node` `webhooks.constructEvent` once it is in the local registry.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  EventEnvelopeLoose,
  parseSignatureHeader,
  signedPayload,
  WEBHOOK_TOLERANCE_SECONDS,
  type z,
} from "@nearpay/spec";

export type WebhookEvent = z.output<typeof EventEnvelopeLoose>;

export type VerifyFailure =
  | "missing_header"
  | "malformed_header"
  | "timestamp_out_of_tolerance"
  | "no_matching_signature"
  | "invalid_body";

export type VerifyResult = { ok: true; event: WebhookEvent } | { ok: false; reason: VerifyFailure };

export function verifyWebhook(
  rawBody: Buffer | string,
  header: string | undefined,
  secrets: readonly string[],
  opts: { now?: number; toleranceSec?: number } = {},
): VerifyResult {
  if (!header) return { ok: false, reason: "missing_header" };
  const parsed = parseSignatureHeader(header);
  if (!parsed) return { ok: false, reason: "malformed_header" };
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (Math.abs(now - parsed.timestamp) > (opts.toleranceSec ?? WEBHOOK_TOLERANCE_SECONDS)) {
    return { ok: false, reason: "timestamp_out_of_tolerance" };
  }
  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const msg = Buffer.from(signedPayload(parsed.timestamp, body), "utf8");
  const match = secrets.some((secret) => {
    const expected = createHmac("sha256", Buffer.from(secret, "utf8")).update(msg).digest();
    return parsed.v1.some((v) => {
      const got = Buffer.from(v, "hex");
      return got.length === expected.length && timingSafeEqual(got, expected);
    });
  });
  if (!match) return { ok: false, reason: "no_matching_signature" };
  let json: unknown;
  try {
    json = JSON.parse(body);
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
