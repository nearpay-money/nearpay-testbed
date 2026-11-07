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
├── scripts/            onboard-live.ts (pnpm onboard:live): live demo merchant onboarding in Chrome (step 1.5)
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

## Mainnet demo

Step 1.5 runs the Stage 1 demo script (`nearpay-brain/roadmap/development-plan.md` §3) on mainnet, using the
local Compose stack in live mode. Use small amounts. **You sign every transaction yourself**: nothing in
NearPay holds a payer's or a merchant's keys.

**1. What the owner provides**

| Item                                                                                                  | Where it goes                                                                                        | Used for                                                |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Treasury NEAR account (receives fees)                                                                 | `NP_TREASURY_ACCOUNT` in `nearpay-deploy/compose/env/local.env`                                      | fee destination in every requirement and quote          |
| Relayer NEAR account with ~1 NEAR for gas                                                             | `NP_RELAYER_ACCOUNT` (same file)                                                                     | submits agents' signed intents to `intents.near`        |
| 4 function-call access keys of the relayer on `intents.near`                                          | `nearpay-deploy/.secrets/live/relayer_key_1` … `relayer_key_4` (near-cli JSON or `ed25519:…`)        | agentpay batcher; one key per in-flight batch           |
| NEAR RPC endpoints (your own key preferred)                                                           | `NP_NEAR_RPC_URLS` (comma-separated)                                                                 | rails, agentpay, the agent's nonce salt                 |
| Base / Arbitrum RPC endpoints                                                                         | `NP_EVM_RPC_URLS_8453`, `NP_EVM_RPC_URLS_42161`                                                      | deposit watchers and receipt verification               |
| 1Click API key (optional)                                                                             | `.secrets/live/oneclick_api_key`                                                                     | quotes without 1Click's unauthenticated fee             |
| NEAR Intents Explorer token (optional)                                                                | `.secrets/live/explorer_token` and `NP_EXPLORER_ENABLED=true`                                        | faster provider status                                  |
| Merchant NEAR account: an implicit account's key (near-cli JSON), or a wallet (e.g. via NEAR Connect) | `nearpay-deploy/.secrets/accounts/merchant.json` for `pnpm onboard:live`, or signed in the dashboard | destination attestation (NEP-413); receives the payouts |
| Payer EVM wallet with ~3 USDC on Base (or Arbitrum) + a little ETH for gas                            | the payer's browser                                                                                  | demo step 3                                             |
| Agent NEAR account with ~1 USDC in its NEAR Intents balance                                           | `NP_AGENT_SECRET_KEY` (or `_FILE`) and `NP_AGENT_ACCOUNT` (default: the key's implicit account)      | demo step 5                                             |

Fund the agent by depositing USDC (`nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`)
into `intents.near` for that account, for example via near-intents.org or `ft_transfer_call` to `intents.near`.

**2. Bring the stack up in live mode**

```sh
cd ../nearpay-deploy
$EDITOR compose/env/local.env           # accounts and RPCs from the table
scripts/seed.sh live                    # validates .secrets/live/*, writes .secrets/live/compose.live.yaml
scripts/up.sh local                     # up.sh/down.sh include the live overlay automatically
```

`NP_ENV` stays `local`: the stack runs on your machine, and the local Turnstile test keys stay in place.
A public deployment needs real Turnstile keys and `NP_ENV=server` (Stage 5).

**3. Demo script**

1. **Merchant goes live.** One command does the whole step:

   ```sh
   pnpm onboard:live              # add --headed to watch Chrome; --help lists the options
   ```

   It needs the merchant's payout key at `../nearpay-deploy/.secrets/accounts/merchant.json` (near-cli JSON
   `{account_id, public_key, private_key}` of an **implicit** account; `--merchant-key` to override), Docker
   (for the ops CLI) and Chrome. Without a human step it:
   - signs up `demo-merchant@nearpay.localhost` (`--email`) as "NearPay Demo Store" (`--business`): magic link
     from Mailpit, then a passkey in Chrome's virtual authenticator. The passkey, private key included, is saved
     to `.secrets/accounts/merchant-passkey.json` (0600); later runs sign in with it;
   - adds a live USDC NEAR Intents destination for the key's account and signs the NEP-413 attestation with
     that key, so payouts go to it; then skips the cool-off and approves KYB through the ops CLI;
   - creates a live secret key and writes it to `.secrets/merchant-demo/secret_key`;
   - adds a live webhook endpoint `http://merchant-demo:3000/webhooks` for all events, and appends its signing
     secret to `.secrets/merchant-demo/webhook_secret`, keeping the existing entries.

   The summary at the end lists the account, the destination and its fingerprint, the key prefix and the
   endpoint. Secrets are never printed. The command is safe to re-run: it continues from wherever the last
   run stopped, and when everything is in place it only checks. The ids it created are kept in
   `.secrets/accounts/merchant-onboard.json`.

   **Manual alternative:**
   - Sign up at `https://dashboard.nearpay.localhost` (magic link from Mailpit at `https://mail.nearpay.localhost`, then a passkey).
   - Add a USDC **NEAR Intents account** destination with your merchant NEAR account, and sign the attestation with your NEAR wallet.
   - Then run, from this repo:

     ```sh
     pnpm ops destination-cooloff-skip sd_…                       # or wait NP_COOLOFF_SECONDS
     pnpm ops kyb-decide acct_… approved --reason "demo merchant"
     ```
   - The account shows **Live**. In **Developers**:
     - create a live secret key and write it to `../nearpay-deploy/.secrets/merchant-demo/secret_key`;
     - add a live webhook endpoint `http://merchant-demo:3000/webhooks` (allowed only while `NP_ENV=local`) and append its signing secret to `.secrets/merchant-demo/webhook_secret`, comma-separated.
   - merchant-demo re-reads both files within 5 s.
2. **Checkout session.** Run `pnpm demo:checkout`. It prints a live hosted-checkout URL (USD 2.00).
3. **Payer pays.** Open the URL. Check the sentinel-verified merchant name and destination fingerprint. Connect the EVM wallet, choose USDC on Base, and pay.
4. **Settlement.** Within about 1–2 minutes the merchant's Intents balance shows 2.00 USDC. `demo:checkout` prints `payment_intent.succeeded`, verified by merchant-demo. The dashboard payment page links the on-chain evidence.
5. **Agent payment.** Run:

   ```sh
   NP_AGENT_SECRET_KEY_FILE=… NP_AGENT_ACCOUNT=… pnpm demo:agent --live
   ```

   The agent gets `402`, signs a NEAR Intents transfer, and receives the resource with `PAYMENT-RESPONSE` in about 2 s. merchant-demo receives `agent_payment.settled`. The price is 0.01 USDC, paid to the merchant's active Intents-account destination for its asset.

**Safety.**

- Live keys and `.secrets/` never leave your machine and are never committed.
- `pnpm ops kill-switch` pauses rails and agentpay at once if anything looks wrong.
- Stop with `scripts/down.sh` in nearpay-deploy.

## Status

Step 1.3: merchant-demo, demo scripts, Stage 1 ops CLI and E2E scaffolding with unit + mock-backed
tests. Step 1.4: every suite above green against the full Compose stack in test mode (traces T1–T7,
sandbox scenarios 00–07).

## Built with

Libraries (hackathon rule Q-005): Express, zod, `@nearpay/spec`, `@nearpay/node`, `@nearpay/x402`, `@nearpay/agent-signer`;
development — TypeScript, Vitest, Playwright, Biome, tsx, `@noble/curves`, canonicalize. Code and
documentation are written with AI assistance (Claude) under human direction and review.
