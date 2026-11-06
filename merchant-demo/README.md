# merchant-demo

The demo merchant backend of the Stage 1 demo (`nearpay-brain/roadmap/development-plan.md` §3, steps 2,
4 and 5; `lld/platform.md` §3). Runs in the `merchant-demo` Compose profile of `nearpay-deploy`
(image `nearpay/merchant-demo:local`, port 3000, `https://merchant-demo.nearpay.localhost`).

| Route                       |                                                                                                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`                     | shop page, "Pay USD 2.00" → `POST /checkout` → hosted checkout                                                                                                                                        |
| `POST /checkout`            | creates a USD 2.00 checkout session (`POST /v1/checkout/sessions`, Idempotency-Key); JSON callers get `{id, url, payment_intent, …}`; `amount` (cents) accepted in test mode only (sandbox scenarios) |
| `GET /orders/:cs_id`        | session + payment intent (status, `amount_settled`, attempts) and the webhook types received for it                                                                                                   |
| `POST /webhooks`            | verifies `NearPay-Signature` v1 on the raw body (all v1 values, constant time, 300 s), dedupes by event id                                                                                            |
| `GET /events?type=&object=` | verified events (only when `NP_ENV` is `local`/`test`)                                                                                                                                                |
| `GET /premium`              | x402 paywall (`@nearpay/x402`), default 10000 base units (0.01 USDC)                                                                                                                                  |
| `GET /healthz`              | `{status, seeded}`                                                                                                                                                                                    |

## Configuration

| Variable                                          | Default                                |                                                                                                                                                                              |
| ------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NP_PUBLIC_API_URL`                               | `https://api.nearpay.localhost`        | API origin (Compose sets it; `NODE_EXTRA_CA_CERTS` trusts the local CA)                                                                                                      |
| `NP_DEMO_PUBLIC_URL`                              | API URL with `api.` → `merchant-demo.` | success URL and x402 resource URLs                                                                                                                                           |
| `NP_DEMO_SECRETS_DIR`                             | `/run/secrets/merchant-demo`           | files `secret_key` (`sk_test_…`) and `webhook_secret` (`whsec_…`, comma-separated during rotation), read lazily (5 s cache) so the container can start before `seed.sh data` |
| `NP_DEMO_SECRET_KEY`, `NP_DEMO_WEBHOOK_SECRET`    | —                                      | override the files (development)                                                                                                                                             |
| `NP_DEMO_CHECKOUT_AMOUNT`                         | `200`                                  | USD cents                                                                                                                                                                    |
| `NP_DEMO_PREMIUM_AMOUNT`, `NP_DEMO_PREMIUM_ASSET` | `10000`, account default               | x402 price                                                                                                                                                                   |
| `NP_ENV`, `PORT`                                  | `local`, `3000`                        |                                                                                                                                                                              |

Uses `@nearpay/node` 0.1.0 for the API (automatic Idempotency-Key, retries) and `constructEvent` for webhooks.
Tests live in `../test/merchant-demo/` (run from the repository root).
