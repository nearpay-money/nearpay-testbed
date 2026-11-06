/**
 * merchant-demo (lld/platform.md §3; Stage 1 demo script steps 2, 4 and 5):
 *
 *   GET  /                 shop page with a "Pay USD 2.00" button
 *   POST /checkout         creates a checkout session via the public API → 303 to the hosted checkout (form)
 *                          or 201 JSON `{id, url, payment_intent, amount, livemode}`
 *   GET  /orders/:id       the session and its payment intent (status, amount settled)
 *   GET  /success          return page (`?session_id=`)
 *   POST /webhooks         signed webhook deliveries (NearPay-Signature v1 verified on the raw body)
 *   GET  /events           verified events received (local/test only; for demo:checkout / demo:agent / E2E)
 *   GET  /premium          paid resource behind the x402 paywall (`@nearpay/x402`)
 *   GET  /healthz          liveness
 */
import { createPaywall, type PaidRequest, type Paywall } from "@nearpay/x402";
import express, { type Express, type Request, type Response } from "express";
import type { Config } from "./config.js";
import { NearPayApiError, type NearPayClient, nearpayClient } from "./nearpay.js";
import { EventStore, verifyWebhook } from "./webhooks.js";

export interface AppDeps {
  config: Config;
  /** Outbound fetch for the NearPay API (tests inject a fake). */
  fetch?: typeof fetch;
  events?: EventStore;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
}

const ID_RE = /^cs_[0-9a-z]{26}$/;
const html = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<style>body{font:16px system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem}button{font:inherit;padding:.6rem 1.2rem;cursor:pointer}code{background:#f3f3f3;padding:.1rem .3rem}</style></head><body>${body}</body></html>`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function createApp(deps: AppDeps): Express {
  const { config } = deps;
  const events = deps.events ?? new EventStore();
  const log = deps.log ?? ((msg, fields) => process.stdout.write(`${JSON.stringify({ msg, ...fields })}\n`));
  const exposeEvents = config.env === "local" || config.env === "test";
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);

  const client = (): NearPayClient | null => {
    const secretKey = config.secrets.secretKey();
    return secretKey
      ? nearpayClient({ apiBase: config.apiBase, secretKey, ...(deps.fetch ? { fetch: deps.fetch } : {}) })
      : null;
  };
  const notSeeded = (res: Response) =>
    res.status(503).json({
      error: "not_configured",
      message: "the demo merchant is not seeded yet (nearpay-deploy/scripts/seed.sh data)",
    });
  const apiFailure = (res: Response, e: unknown) => {
    if (e instanceof NearPayApiError) {
      log("nearpay api error", { status: e.status, code: e.code, message: e.message });
      return res
        .status(e.status >= 400 && e.status < 500 ? e.status : 502)
        .json({ error: e.code ?? "api_error", message: e.message });
    }
    throw e;
  };

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", seeded: config.secrets.secretKey() !== null });
  });

  app.get("/", (_req, res) => {
    const usd = (config.checkoutAmount / 100).toFixed(2);
    res
      .type("html")
      .send(
        html(
          "NearPay demo shop",
          `<h1>NearPay demo shop</h1><p>A digital sticker pack — <strong>USD ${usd}</strong>, payable from any chain.</p>` +
            `<form method="post" action="/checkout"><button type="submit" id="pay">Pay USD ${usd}</button></form>` +
            `<p>Agents: <code>GET /premium</code> costs ${esc(config.premiumAmount)} base units over x402.</p>`,
        ),
      );
  });

  app.post(
    "/checkout",
    express.json(),
    express.urlencoded({ extended: false }),
    async (req: Request, res: Response) => {
      const c = client();
      if (!c) return notSeeded(res);
      const testMode = config.secrets.secretKey()?.startsWith("sk_test_") ?? false;
      // Test mode only: E2E picks sandbox scenarios by the amount suffix (api-conventions §8).
      const requested = (req.body as { amount?: unknown } | undefined)?.amount;
      let amount = config.checkoutAmount;
      if (requested !== undefined && requested !== "") {
        const n = Number(requested);
        if (!testMode || !Number.isSafeInteger(n) || n < 100 || n > 100_000) {
          return res
            .status(400)
            .json({ error: "invalid_amount", message: "amount (cents, 100–100000) is accepted in test mode only" });
        }
        amount = n;
      }
      // Test mode only: a short session lifetime for the late-settlement scenario 07 (INV-3).
      const expiresIn = (req.body as { expires_in?: unknown } | undefined)?.expires_in;
      let expires: number | undefined;
      if (expiresIn !== undefined && expiresIn !== "") {
        const n = Number(expiresIn);
        if (!testMode || !Number.isSafeInteger(n) || n < 300 || n > 86_400) {
          return res
            .status(400)
            .json({ error: "invalid_expires_in", message: "expires_in (300–86400 s) is accepted in test mode only" });
        }
        expires = n;
      }
      try {
        const session = await c.createCheckoutSession({
          amount,
          ...(expires ? { expires_in: expires } : {}),
          currency: "usd",
          success_url: `${config.publicUrl}/success`,
          cancel_url: `${config.publicUrl}/`,
          description: "Digital sticker pack",
          metadata: { order: `demo-${Date.now()}` },
        });
        log("checkout session created", { id: session.id, amount, livemode: session.livemode });
        if (req.is("application/x-www-form-urlencoded") && session.url) return res.redirect(303, session.url);
        return res.status(201).json({
          id: session.id,
          url: session.url,
          payment_intent:
            typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent.id,
          amount: session.amount,
          currency: session.currency,
          livemode: session.livemode,
          expires_at: session.expires_at,
        });
      } catch (e) {
        return apiFailure(res, e);
      }
    },
  );

  app.get("/orders/:id", async (req, res) => {
    if (!ID_RE.test(req.params.id)) return res.status(404).json({ error: "not_found" });
    const c = client();
    if (!c) return notSeeded(res);
    try {
      const s = await c.getCheckoutSession(req.params.id);
      const pi = typeof s.payment_intent === "string" ? null : s.payment_intent;
      return res.json({
        id: s.id,
        status: s.status,
        livemode: s.livemode,
        amount: s.amount,
        currency: s.currency,
        payment_intent: pi
          ? {
              id: pi.id,
              status: pi.status,
              amount_settled: pi.amount_settled,
              settlement_asset_id: pi.settlement_asset_id,
              succeeded_at: pi.succeeded_at,
              late: pi.late,
              attempts: pi.attempts,
            }
          : { id: s.payment_intent },
        events: events.list({ object: pi?.id ?? String(s.payment_intent) }).map((e) => e.type),
      });
    } catch (e) {
      return apiFailure(res, e);
    }
  });

  app.get("/success", (req, res) => {
    const id =
      typeof req.query.session_id === "string" && ID_RE.test(req.query.session_id) ? req.query.session_id : null;
    res
      .type("html")
      .send(
        html(
          "Thank you",
          `<h1>Thank you!</h1><p>${id ? `Order <code id="session">${id}</code> — status: <a href="/orders/${id}">/orders/${id}</a>` : "No session."}</p>`,
        ),
      );
  });

  app.post("/webhooks", express.raw({ type: () => true, limit: "1mb" }), (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const r = verifyWebhook(
      raw,
      req.get("nearpay-signature"),
      config.secrets.webhookSecrets(),
      deps.now ? { now: deps.now() } : {},
    );
    if (!r.ok) {
      log("webhook rejected", { reason: r.reason, detail: r.detail });
      return res.status(400).json({ error: r.reason });
    }
    const fresh = events.add(r.event);
    log("webhook received", { id: r.event.id, type: r.event.type, duplicate: !fresh, object: r.event.data.object.id });
    return res.json({ received: true });
  });

  app.get("/events", (req, res) => {
    if (!exposeEvents) return res.status(404).json({ error: "not_found" });
    const type = typeof req.query.type === "string" ? req.query.type : undefined;
    const object = typeof req.query.object === "string" ? req.query.object : undefined;
    return res.json({
      object: "list",
      data: events.list({ ...(type ? { type } : {}), ...(object ? { object } : {}) }),
    });
  });

  // x402: one paywall per secret key (the key appears once the merchant is seeded).
  let paywall: { key: string; run: Paywall } | null = null;
  app.get("/premium", async (req, res, next) => {
    const key = config.secrets.secretKey();
    if (!key) return notSeeded(res);
    if (paywall?.key !== key) {
      paywall = {
        key,
        run: createPaywall(
          {
            amount: config.premiumAmount,
            ...(config.premiumAsset ? { asset: config.premiumAsset } : {}),
            description: "Premium market insight",
            mimeType: "application/json",
          },
          {
            secretKey: key,
            apiBase: config.apiBase,
            ...(deps.fetch ? { fetch: deps.fetch } : {}),
            onError: (e) => log("x402 facilitator error", { message: (e as Error).message }),
          },
        ),
      };
    }
    try {
      // The resource URL is the public one (behind Traefik), not the container's.
      const out = await paywall.run({ url: `${config.publicUrl}${req.originalUrl}`, header: (n) => req.get(n) });
      if (!out.paid) return res.status(out.status).set(out.headers).json(out.body);
      res.set(out.headers);
      const paid: PaidRequest = out;
      log("x402 settled", {
        payer: paid.payer,
        transaction: paid.settlement.transaction,
        amount: paid.settlement.amount,
      });
      return res.json({
        object: "premium_content",
        insight: "NEAR Intents settle cross-chain payments in about two seconds.",
        paid_by: paid.payer,
        transaction: paid.settlement.transaction,
      });
    } catch (e) {
      return next(e);
    }
  });

  return app;
}
