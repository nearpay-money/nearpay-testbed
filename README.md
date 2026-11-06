# nearpay-testbed

> Whole-system verification and demos: merchant-demo app, demo scripts (checkout, agent), Stage 1 ops CLI, cross-service E2E, consumer-driven contract tests, load tests (k6), chaos scenarios, mainnet canary runner, recorded provider fixtures.

|                                       |                         |
| ------------------------------------- | ----------------------- |
| Group                                 | Platform                |
| Kind                                  | tests                   |
| Ships as                              | CI + scheduled jobs     |
| Owns                                  | System tests            |
| Depends on (published artifacts only) | all published artifacts |
| First built in                        | Stage 1 (steps 1.3–1.5) |

## Documentation

This repo stays surgical: design docs live in [`nearpay-brain`](../nearpay-brain/README.md), not here.

- `nearpay-brain/lld/platform.md` — **low-level design (dev-ready; implement from this)**
- `nearpay-brain/lld/audits/platform.md` — audit findings already folded into the LLD
- `nearpay-brain/roadmap/development-plan.md` — stage and step this repo is built in
- `nearpay-brain/architecture/hld.md` — system design
- `nearpay-brain/architecture/repositories.md` — repo topology and dependency rules
- `nearpay-brain/quality/stress-test.md`
- `nearpay-brain/quality/capacity.md`

## Layout (Stage 1)

```
nearpay-testbed/
├── merchant-demo/      demo merchant (own package + Dockerfile; image nearpay/merchant-demo:local) — see its README
├── demo/               checkout.ts (pnpm demo:checkout, demo steps 2–4), agent.ts (pnpm demo:agent, step 5)
├── ops/                Stage 1 ops CLI (pnpm ops …): KYB decision, kill switch, cool-off skip → docker compose exec
├── lib/                spec-route HTTP client, stack locations, merchant-demo client, scripted payers, scenarios 00–07
├── e2e/                full-stack suites for step 1.4: api/ (T1, T2/T6, T7, scenarios), agent/ (T4, T5), checkout/ (T3, hosted UI)
├── test/               unit + mock-backed tests (mock stack: spec-validated fake API, sentinel test key, webhooks)
├── canary/ chaos/ load/ contract-tests/ fixtures/ compose/   later steps
└── .github/
```

## Setup

```sh
pnpm setup            # root + merchant-demo installs (@nearpay/* from the local registry)
pnpm verify           # typecheck, lint, unit + mock-backed tests (coverage gate), Playwright (system Chrome), build
```

## Demo (Stage 1 demo script, test mode against the local stack)

Prerequisites: `nearpay-deploy/scripts/up.sh` (with the `merchant-demo` profile) and `scripts/seed.sh data`
(demo merchant key and webhook secret in `nearpay-deploy/.secrets/merchant-demo/`).

```sh
pnpm demo:checkout                 # [2] session via merchant-demo → [3] scripted payer verifies sentinel, simulates the deposit → [4] signed webhook
pnpm demo:checkout --amount 205    # sandbox scenario 05 (test mode amount suffix)
pnpm demo:agent                    # [5] 402 → signed Intents transfer → 200 + PAYMENT-RESPONSE → agent_payment.settled
pnpm demo:agent --live             # mainnet (step 1.5): NP_AGENT_SECRET_KEY(_FILE), NP_AGENT_ACCOUNT, salt from NEAR RPC
```

Live mode (step 1.5): `demo:checkout` prints the hosted checkout URL for a human with an EVM wallet.

**Agent funding (test mode).** The sandbox Verifier keeps simulated Intents balances; the demo agent
(test-only key, implicit account `0857962d91335176f92257df38175401936a4ca31b832f0c98c77b836800c655`)
needs USDC there before `demo:agent`, T3, T4 and T5. There is no public route for it: `seed.sh data`
(or a sandbox ops command) must fund it — see the step 1.3 report.

## Ops (Stage 1, local only)

```sh
pnpm ops kyb-decide acct_… approved --reason "documents checked"
pnpm ops kill-switch
pnpm ops kill-switch-release "false alarm, quote re-checked" --yes
pnpm ops destination-cooloff-skip sd_…
```

Each runs `docker compose -p nearpay … exec -T <svc>-api /nodejs/bin/node dist/ops.js …` with
`nearpay-deploy`'s files (`--deploy <dir>` or `NP_DEPLOY_DIR`); there is no network path to these actions.

## E2E (step 1.4)

Against nearpay-deploy's stack (`scripts/up.sh` with the `merchant-demo` profile, then `scripts/seed.sh data`):

```sh
export NODE_EXTRA_CA_CERTS=../nearpay-deploy/.secrets/tls/ca.pem    # set it explicitly; trusts the local CA
pnpm test:e2e                       # T2–T7 + scenarios 00/03/04/05/06 (~3 min)
NP_E2E_SLOW=1 pnpm test:e2e         # + 01, 02, 07 side by side (~35 min: 02 waits for the 30 min quote deadline)
NP_E2E=1 pnpm test:pw               # Chrome: hosted checkout (T2/T6 UI) and dashboard onboarding (T1)
NP_E2E=mock pnpm exec vitest run --project e2e                      # suite logic against the mock stack
```

| Suite                                 | Covers                                                                                                                                                                                                                             |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e/api/checkout`                    | T2/T6: session → sentinel-verified instructions → simulated deposit → signed webhooks; INV-2 evidence                                                                                                                              |
| `e2e/api/scenarios`                   | sandbox 00–07 (`lib/scenarios.ts`): final intent/attempt/session state, required and forbidden webhooks, statement lines                                                                                                           |
| `e2e/api/kill-switch`                 | T7: spoofed request refused without engaging; drill engage → rails stops quoting → ops CLI release                                                                                                                                 |
| `e2e/api/onboarding`                  | T1 ops half: the seeded merchant is visible to ops                                                                                                                                                                                 |
| `e2e/checkout/intents`, `e2e/agent/*` | T3 (Intents balance, NEP-413), T4 (x402 `/premium`), T5 (agent pays a session)                                                                                                                                                     |
| `e2e/checkout/hosted.pw.ts`           | the hosted checkout in Chrome: manual path, verified merchant + fingerprint, address after network confirmation, simulate, redirect, webhook                                                                                       |
| `e2e/dashboard/onboarding.pw.ts`      | T1 in Chrome: sign-up → magic link (Mailpit) → passkey (CDP virtual authenticator) → live NEAR Intents destination signed with NEP-413 by a fresh implicit account → cool-off skip (ops CLI) → KYB → ops decision → `live_enabled` |

Scenario outcomes (domain-model §4–§5): 00 succeeded; 01 processing then succeeded; 02 attempt refunded at the
deadline, intent back to `requires_payment`, session open; 03 succeeded, excess refunded (no overpayment); 04
`FAILED` after the deposit → attempt `held` (`failed_after_deposit`), intent `requires_review`
(`verification_held`), no success or failure event; 05 `requires_review` (`short_settlement`), no succeeded event;
06 succeeded + `overpaid` (`duplicate`); 07 settles after the session's `expires_at`, `late: true`.

The browser tests stub Cloudflare Turnstile with the dummy token of the always-pass test sitekey (services
answer the local test secret themselves) and serve an empty NEAR Connect manifest, so no third-party script
is loaded. Chrome trusts the local certificate through its pinned SPKI (`playwright.config.ts`), which
WebAuthn needs. The scripted payer asks sentinel again (up to 4 tries) while it answers
`503 attestation_unavailable`; every answer is still verified against the pinned key.

## Status

Step 1.3: merchant-demo, demo scripts, Stage 1 ops CLI and E2E scaffolding with unit + mock-backed
tests. Step 1.4: every suite above green against the full Compose stack in test mode (traces T1–T7,
sandbox scenarios 00–07).

## Built with

Libraries (hackathon rule Q-005): Express, zod, `@nearpay/spec`, `@nearpay/node`, `@nearpay/x402`, `@nearpay/agent-signer`;
development — TypeScript, Vitest, Playwright, Biome, tsx, `@noble/curves`, canonicalize. Code and
documentation are written with AI assistance (Claude) under human direction and review.
