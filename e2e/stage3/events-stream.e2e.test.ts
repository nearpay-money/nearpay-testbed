/**
 * Stage 3 scenario 3 — events stream (webhooks §5.1, spec `streamEvents`), consumed the way `nearpay listen` does
 * through the gateway (Traefik → webhooks-api, flushed per event): `ready` first, then the invoice lifecycle's events
 * in id order as they happen; disconnect, more events happen (the invoice is paid), reconnect with `Last-Event-ID` →
 * exactly the missed events, in order, then live again; `starting_after` resumes the same way; unknown types are
 * refused. Streamed events are the objects `GET /v1/events/{id}` returns.
 */
import { getEvent } from "@nearpay-money/spec";
import { beforeAll, describe, expect, it } from "vitest";
import { openEventStream, type StreamEvent } from "../../lib/sse.js";
import { realStack, stack } from "../support/env.js";
import { api } from "../support/stage2.js";
import { catalogue, invoiceUntil, payInvoice, sentInvoice } from "../support/stage3.js";

const TYPES = ["invoice.created", "invoice.finalized", "invoice.sent", "invoice.paid", "payment_intent.succeeded"];
const of = (evs: StreamEvent[], id: string) => evs.filter((e) => e.data.object.id === id);
const ascending = (evs: StreamEvent[]) => evs.every((e, i) => i === 0 || (evs[i - 1] as StreamEvent).id < e.id);

describe.skipIf(!realStack)("Stage 3 · events stream", () => {
  let cat: Awaited<ReturnType<typeof catalogue>>;
  const open = (o: { lastEventId?: string; startingAfter?: string; types?: string[] } = {}) =>
    openEventStream({ apiUrl: stack().apiUrl, key: stack().secretKey() as string, types: TYPES, ...o });
  beforeAll(async () => {
    cat = await catalogue("sse");
  });

  it("live events in order, then Last-Event-ID resume replays exactly what was missed", async () => {
    const s1 = await open();
    expect(s1.status).toBe(200);
    await s1.waitFor(() => s1.frames.some((f) => f.event === "ready"), 15_000, "ready frame");
    expect(s1.frames[0]?.event).toBe("ready");

    const inv = await sentInvoice(cat, "sse");
    const seen = await s1.waitFor((evs) => of(evs, inv.id).length >= 3, 60_000, `3 events of ${inv.id}`);
    const lifecycle = of(seen, inv.id);
    expect(lifecycle.map((e) => e.type)).toEqual(["invoice.created", "invoice.finalized", "invoice.sent"]);
    expect(ascending(s1.events)).toBe(true);
    expect(s1.events.every((e) => e.livemode === false)).toBe(true);
    // a streamed event is exactly what GET /v1/events/{id} returns
    const last = lifecycle[2] as StreamEvent;
    expect(await api(getEvent, { params: { id: last.id } })).toMatchObject({ id: last.id, type: "invoice.sent" });
    s1.close();
    await s1.done;

    // while disconnected the invoice is paid
    await payInvoice(inv.hosted_invoice_url as string);
    const paid = await invoiceUntil(inv.id, (i) => i.status === "paid", 3 * 60_000, "paid");

    const s2 = await open({ lastEventId: last.id });
    expect(s2.status).toBe(200);
    const replay = await s2.waitFor(
      (evs) => evs.some((e) => e.type === "invoice.paid" && e.data.object.id === inv.id),
      60_000,
      `invoice.paid of ${inv.id} after resume`,
    );
    expect(replay.every((e) => e.id > last.id)).toBe(true);
    expect(ascending(replay)).toBe(true);
    expect(new Set(replay.map((e) => e.id)).size).toBe(replay.length);
    expect(replay.some((e) => e.type === "payment_intent.succeeded" && e.data.object.id === paid.payment_intent)).toBe(
      true,
    );
    // …and it continues live after the replay
    const inv2 = await sentInvoice(cat, "sse-live");
    await s2.waitFor((evs) => of(evs, inv2.id).length >= 3, 60_000, `live events of ${inv2.id}`);
    expect(ascending(s2.events)).toBe(true);
    s2.close();

    // starting_after (query) resumes the same way
    const s3 = await open({ startingAfter: last.id, types: ["invoice.paid"] });
    const again = await s3.waitFor(
      (evs) => evs.some((e) => e.data.object.id === inv.id),
      60_000,
      "invoice.paid via starting_after",
    );
    expect(again.every((e) => e.type === "invoice.paid")).toBe(true);
    s3.close();
  });

  it("an unknown event type is refused", async () => {
    const s = await open({ types: ["invoice.teleported"] });
    expect(s.status).toBe(400);
    s.close();
  });
});
