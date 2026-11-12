# nearpay-testbed

Whole-system verification and demos: the merchant-demo app, demo scripts (checkout, agent), an ops CLI wrapper for local stacks and the cross-service end-to-end suites (Stages 1–4).

Part of [NearPay](https://github.com/nearpay-money/nearpay) — start there for the live demo, the architecture diagram and the full "do X, see Y" walkthrough.

- **Where it sits:** outside the product. It drives a running NearPay stack (the Compose stack from `nearpay-deploy`) the way a merchant, a payer, an agent and an operator would, using only published artifacts: the public API, `@nearpay-money/node`, `@nearpay-money/x402`, `@nearpay-money/agent-signer`, the CLI and the browser apps.
- **Status:** NearPay runs on NEAR mainnet as a closed beta (https://nearpay.money). The suites here run against a local stack in test mode; the "Mainnet demo" section below is the self-hosted variant of the live walkthrough in the entry repo. The load tests, chaos scenarios, canary runner, consumer-driven contract tests and recorded provider fixtures named in the design are not built: `load/`, `chaos/`, `canary/`, `contract-tests/`, `compose/`, `fixtures/near/` and `fixtures/oneclick/` are empty placeholders.

|                                       |                         |
| ------------------------------------- | ----------------------- |
| Group                                 | Platform                |
| Kind                                  | tests                   |
| Ships as                              | CI + scheduled jobs     |
| Owns                                  | System tests            |
| Depends on (published artifacts only) | all published artifacts |
| First built in                        | Stage 1 (steps 1.3–1.5) |

## Documentation

Design docs live in [`nearpay-brain`](https://github.com/nearpay-money/nearpay-brain), not here.

- [`lld/platform.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/lld/platform.md) — low-level design this repo is implemented from
- [`lld/audits/platform.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/lld/audits/platform.md) — audit findings already folded into the LLD
- [`roadmap/development-plan.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/roadmap/development-plan.md) — stage and step this repo is built in
- [`architecture/hld.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/architecture/hld.md) — system design
- [`architecture/repositories.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/architecture/repositories.md) — repo topology and dependency rules
- [`quality/stress-test.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/quality/stress-test.md)
- [`quality/capacity.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/quality/capacity.md)

## Layout

```
nearpay-testbed/
├── merchant-demo/      demo merchant (own package + Dockerfile; image nearpay/merchant-demo:local) — see its README
├── demo/               checkout.ts (pnpm demo:checkout, demo steps 2–4), agent.ts (pnpm demo:agent, step 5)
├── ops/                ops CLI for local stacks (pnpm ops …): operators, KYB decision (manual mode), kill switch, cool-off skip → docker compose exec
├── scripts/            onboard-live.ts (pnpm onboard:live): live demo merchant onboarding in Chrome (step 1.5)
├── lib/                spec-route HTTP client, stack locations, merchant-demo client, scripted payers, scenarios 00–07
├── e2e/                full-stack suites: api/ (T1, T2/T6, T7, scenarios), agent/ (T4, T5), checkout/ (T3, hosted UI), dashboard/, stage2/, stage3/, stage4/
├── test/               unit + mock-backed tests (mock stack: spec-validated fake API, sentinel test key, webhooks)
├── fixtures/           the synthetic OFAC list (ofac/); near/ and oneclick/ are empty
├── canary/ chaos/ load/ contract-tests/ compose/   empty placeholders (not built)
└── .github/
```

## Verify this repo

Needs Node 22, pnpm 9 and, for step 4, Google Chrome. Steps 1–4 need no Docker and no running stack. `.npmrc` points the `@nearpay-money` and `@nearpay-internal` scopes at a local package registry, so start that first.

1. Start the local registry (no Docker, Node 22 only):
   `git clone https://github.com/nearpay-money/nearpay-deploy ../nearpay-deploy && ../nearpay-deploy/scripts/registry.sh start`
   → `curl http://127.0.0.1:4873/-/ping` answers `{}`.
2. `pnpm run setup` (installs the root package and `merchant-demo/`) → both installs end with `Done in …`. Type `pnpm run setup`, not `pnpm setup`: the bare form is pnpm's own command, which edits your shell profile and installs nothing here.
3. `pnpm test` (unit tests and tests against a mock stack: a spec-validated fake API, a sentinel test key, webhooks) → `Test Files  12 passed (12)`, `Tests  135 passed (135)`. If step 2 was skipped, four files fail with `Failed to load url @nearpay-money/node`.
4. `pnpm verify` (the gate: typecheck, lint, the same tests with the coverage gate, the mock-backed Playwright tests in the system Chrome, build of merchant-demo) → exits 0; the Playwright list ends with `2 passed`.
5. The full-stack suites (`pnpm test:e2e`, `NP_E2E=1 pnpm test:pw`) need Docker and a running stack from `nearpay-deploy`; see "E2E" below. They are not part of `pnpm verify`.

## Setup

```sh
pnpm run setup        # root + merchant-demo installs (@nearpay-money/* from the local registry)
pnpm verify           # typecheck, lint, unit + mock-backed tests (coverage gate), Playwright (system Chrome), build
```

Node.js 22 is the tested version; Node 24 works, with pnpm's `Unsupported engine` warning.

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

## Ops (local only)

Operators work in the console (`https://ops.nearpay.localhost`); add one with a role (`ops` or `ops_admin`, enforced
per console route since kit 0.2.0) and open the enrolment link from Mailpit:

```sh
pnpm ops operator-add ops@example.test ops_admin
pnpm ops operator-revoke ops@example.test
pnpm ops sanctions-import                      # offline stacks: loads the synthetic OFAC list (fixtures/ofac)
```

Drill commands (local stacks):

```sh
pnpm ops kyb-decide acct_… approved --reason "documents checked"   # only with NP_KYB_MODE=manual (ADR-0024)
pnpm ops kill-switch
pnpm ops kill-switch-release "false alarm, quote re-checked" --yes
pnpm ops destination-cooloff-skip sd_…                             # only on a stack with NP_COOLOFF_SECONDS > 0 (ADR-0027)
```

Payout wallets have no cool-off (ADR-0027): identity's default, the beta and `nearpay-deploy`'s
`compose/env/local.env.example` all set `NP_COOLOFF_SECONDS=0`, so a wallet is active in the same request as its
attestation. On such a stack `destination-cooloff-skip` exits 1 with `state_conflict` (the wallet is not
`cooling_off`). The suites therefore run the skip only for a wallet identity reports as `cooling_off`
(`lib/destinations.ts`), which happens only when you set `NP_COOLOFF_SECONDS` > 0 in your `local.env`.

Each runs `docker compose -p nearpay … exec -T <svc>-api /nodejs/bin/node dist/ops.js …` with
`nearpay-deploy`'s files (`--deploy <dir>` or `NP_DEPLOY_DIR`); there is no network path to these actions.

## E2E (step 1.4)

Against nearpay-deploy's stack (`scripts/up.sh` with the `merchant-demo` profile, then `scripts/seed.sh data`):

```sh
export NODE_EXTRA_CA_CERTS=../nearpay-deploy/.secrets/tls/ca.pem    # set it explicitly; trusts the local CA
pnpm test:e2e                       # T2–T7 + scenarios 00/03/04/05/06 + Stage 2/3/4 (e2e/stage2, e2e/stage3, e2e/stage4)
NP_E2E_SLOW=1 pnpm test:e2e         # + 01, 02, 07 side by side (~35 min: 02 waits for the 30 min quote deadline), vault 91 fallback
NP_E2E=1 pnpm test:pw               # Chrome: hosted checkout (T2/T6 UI), dashboard onboarding (T1), hosted invoice, CLI login
NP_E2E=mock pnpm exec vitest run --project e2e                      # suite logic against the mock stack
```

| Suite                                 | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `e2e/api/checkout`                    | T2/T6: session → sentinel-verified instructions → simulated deposit → signed webhooks; INV-2 evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `e2e/api/scenarios`                   | sandbox 00–07 (`lib/scenarios.ts`): final intent/attempt/session state, required and forbidden webhooks, statement lines                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `e2e/api/kill-switch`                 | T7: spoofed request refused without engaging; operator drill engage → rails stops quoting, agentpay pauses → ops CLI release (an operator's stop is never released automatically, ADR-0028)                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `e2e/api/onboarding`                  | T1 ops half: the seeded merchant is visible to ops                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `e2e/checkout/intents`, `e2e/agent/*` | T3 (Intents balance, NEP-413), T4 (x402 `/premium`), T5 (agent pays a session)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `e2e/checkout/hosted.pw.ts`           | the hosted checkout in Chrome: manual path, "Pay with" (network Base, token USDC, Continue), refund address, verified merchant + fingerprint, address after network confirmation, simulate, redirect, webhook                                                                                                                                                                                                                                                                                                                                                                                                            |
| `e2e/stage2/refunds`                  | route refund to the payer's origin chain (test-mode signing path) → `succeeded` + evidence, signed `refund.succeeded`, receipt in Mailpit; merchant-signed Intents refund relayed by agentpay                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `e2e/stage2/payment-links`            | link paid from Base while settling on NEAR: session complete, `uses` + 1, `payment_intent.succeeded`, hosted `/l/` never framed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `e2e/stage2/reconciliation`           | console re-run of a completed day → `ok`, `diff_count 0`; evidence unavailable → `error` run → `reconciliation_diff` compliance case (stops and restarts `rails-api`)                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `e2e/stage2/console`                  | two-person kill-switch release (requester and `ops` role refused); self-declared KYB → live at once (auto; console approval only with NP_KYB_MODE=manual) → abuse reject/reverse                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `e2e/dashboard/onboarding.pw.ts`      | T1 in Chrome: sign-up → magic link (Mailpit) → passkey (CDP virtual authenticator) → live payout wallet (NEAR Intents account) signed with NEP-413 by a fresh implicit account → "Payout wallet active" at once (ops CLI cool-off skip only on a stack with `NP_COOLOFF_SECONDS` > 0) → business details (no register number) → automatic decision (ops CLI only with NP_KYB_MODE=manual) → `live_enabled`                                                                                                                                                                                                               |
| `e2e/stage3/invoices`                 | catalogue + tax → draft → finalize → send → `Invoice … [test]` mail with the hosted link → paid from Base (EVM) and from Solana via the hosted-invoice session (sentinel-attested) → `invoice.paid`, receipt mail, PDF `PAID`; void (`VOID`, payment refused) and uncollectible (stamped, still payable)                                                                                                                                                                                                                                                                                                                 |
| `e2e/stage3/subscriptions`            | first invoice → `active` → test clock `renewal_upcoming` (event + mail) → `renewal` invoice paid from Solana → next renewal unpaid → `overdue` (`invoice.overdue`, `past_due`, overdue mail) → paid → `active`                                                                                                                                                                                                                                                                                                                                                                                                           |
| `e2e/stage3/events-stream`            | `GET /v1/events/stream` through the gateway: `ready`, invoice events in id order, `Last-Event-ID` resume replays exactly what was missed, then live; `starting_after`; unknown type refused                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `e2e/stage3/agents`                   | `@nearpay-money/x402` cross-chain (near-intents) paywall + client → settled → `agent_payment.settled`; a failing delivery records no agent payment; `@nearpay-money/mcp` stdio pays a checkout session and a hosted invoice (budget + allow-list refusals); embedded MCP pays the cross-chain resource; reconciliation still `ok`                                                                                                                                                                                                                                                                                        |
| `e2e/stage3/hosted-invoice.pw.ts`     | the hosted invoice `/i/:id` in Chrome: `no-referrer`, document, pay from Base ("Pay with" dropdowns), simulate, paid, receipt PDF `PAID`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `e2e/stage3/cli.pw.ts`                | `nearpay login --no-browser` approved on the dashboard `/cli/authorize` (passkey sign-in + step-up) → `whoami` → `listen --forward-to` (HMAC-verified) → `trigger` payment_intent.succeeded, refund.succeeded, refund.failed unsupported, requires_review (05), overpaid (06)                                                                                                                                                                                                                                                                                                                                            |
| `e2e/stage4/mandates`                 | auto-debit on the sandbox vault stand-in: `prepareMandate` = hosted-page funding (no side effects) → simulated payer funds 3 periods (`ft_transfer_call`) → `mandate.activated` → keeper collects period 1 → invoice paid with `mandate_collection` evidence, merchant's Intents balance + share → renewal collected as period 2 → withdraw while active refused → payer cancel refunds the rest (`mandate.canceled`) → withdraw has nothing left; payer mails. Insufficient funds: renewal collect fails → `mandate.insufficient_funds` + mail → invoice falls back to `send_invoice`, paid on the hosted page → top-up |
| `e2e/stage4/vault-scenarios`          | stand-in scenarios by `amount_per_period` suffix (asset-priced): `91` collect_failed (not counted; slow: fallback after 5), `92` fee leg fails (paid, fee stays in the balance), `93` first refund fails (cancel refunds 0 → withdraw), `94` partial delivery (short share: invoice voided with the collection, balance invoice sent)                                                                                                                                                                                                                                                                                    |
| `e2e/stage4/chains`                   | Solana payer (USDC SPL and native SOL): attested Solana deposit, no memo, attested asset (mint / native) for the wallet recipe, Solana Pay URI → paid, Solana refund address recorded; Bitcoin manual path: P2WPKH deposit, no memo, BIP-21 amount → paid                                                                                                                                                                                                                                                                                                                                                                |

**Stage 3 clients (step 3.4).** `@nearpay-money/cli`, `@nearpay-money/mcp`, `@nearpay-money/x402` and
`@nearpay-money/agent-signer` are dependencies of this repo (published packages from the local registry), so
`pnpm run setup` installs them and no sibling repository has to be built. `lib/artifacts.ts` loads the installed
package when it is at least the Stage 3 version, otherwise the build output of the sibling repository's main checkout
(`NP_AGENTKIT_DIR`, `NP_REPOS_DIR`; never their source); `NP_CLI_BIN` runs another CLI build.
Child processes get `lib/localhost-dns-preload.mjs`. Test mode has no origin chain: the cross-chain origin signer only
reports a deposit transaction, which the sandbox 1Click records when rails submits it. Reconciliation can only run on
completed UTC days, so on a fresh stack the agentpay-owner filter is exercised only with `NP_E2E_RECON_DAY` set to a
day with agent payments.

**Stage 4 (step 4.4).** Needs `@nearpay-money/spec` 0.4.0 and the Stage 4 services (billing keeper and mandate mirror,
rails vault indexer, sandbox vault stand-in and Solana/Bitcoin simulation, sentinel/identity chain support, notify
mandate mails, webhooks with the `mandate.*` types). The simulated payer acts through the public test helpers
(`/v1/test_helpers/mandates/fund`, `…/{id}/payer_action`), which billing submits to the stand-in's
`/sim/vault/ft_transfer_call` and `/sim/vault/call` as `sandbox-payer.near`; everything after the funding transaction is
the real pipeline (vault receipts → rails → billing mirror and keeper → events → webhooks → notify). The merchant's Intents
balance is read with the sandbox ops CLI (`intents-balance`).

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

Both runners prepare the stack first (`e2e/support/global-setup.ts`, for Playwright `pw-global-setup.ts`): when
compliance has no sanctions list yet (an offline machine), they load the synthetic one, because a live payout wallet
is screened before it activates. The browser suites drive the dashboard and the checkout by the test ids, labels and
button names those apps have on `main` (their own Playwright suites use the same ones); after a redesign of either
app, update the selectors here in the same change.

## Mainnet demo

NearPay itself now runs on mainnet at https://nearpay.money; to try that deployment follow the
[entry repo](https://github.com/nearpay-money/nearpay). This section is the self-hosted variant: it runs the Stage 1
demo script ([`roadmap/development-plan.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/roadmap/development-plan.md) §3) on mainnet, using your own
local Compose stack in live mode. Use small amounts. **You sign every transaction yourself**: nothing in
NearPay holds a payer's or a merchant's keys.

**1. What the owner provides**

| Item                                                                                                  | Where it goes                                                                                                                | Used for                                                |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Treasury NEAR account (receives fees)                                                                 | `NP_TREASURY_ACCOUNT` in `nearpay-deploy/compose/env/local.env`                                                              | fee destination in every requirement and quote          |
| Relayer NEAR account with ~1 NEAR for gas                                                             | `NP_RELAYER_ACCOUNT` (same file)                                                                                             | submits agents' signed intents to `intents.near`        |
| 4 function-call access keys of the relayer on `intents.near`                                          | `nearpay-deploy/.secrets/live/relayer_key_1` … `relayer_key_4` (near-cli JSON or `ed25519:…`)                                | agentpay batcher; one key per in-flight batch           |
| NEAR RPC endpoints (your own key preferred)                                                           | `NP_NEAR_RPC_URLS` (comma-separated)                                                                                         | rails, agentpay, the agent's nonce salt                 |
| Base / Arbitrum RPC endpoints                                                                         | `NP_EVM_RPC_URLS_8453`, `NP_EVM_RPC_URLS_42161`                                                                              | deposit watchers and receipt verification               |
| 1Click API key (optional)                                                                             | `.secrets/live/oneclick_api_key`                                                                                             | quotes without 1Click's unauthenticated fee             |
| NEAR Intents Explorer token (optional)                                                                | `.secrets/live/explorer_token` and `NP_EXPLORER_ENABLED=true`                                                                | faster provider status                                  |
| Merchant NEAR account: an implicit account's key (near-cli JSON), or a wallet (e.g. via NEAR Connect) | `nearpay-deploy/.secrets/accounts/merchant.json` for `pnpm onboard:live`, or signed in the dashboard                         | destination attestation (NEP-413); receives the payouts |
| Payer EVM wallet with ~3 USDC on Base (or Arbitrum) + a little ETH for gas                            | the payer's browser                                                                                                          | demo step 3                                             |
| Agent NEAR account with ~1 USDC and **0.2 NEAR** for gas (0.1 is refused: `NotEnoughBalance`)         | `nearpay-deploy/.secrets/accounts/agent.json` (near-cli JSON); for the demo `NP_AGENT_SECRET_KEY(_FILE)`, `NP_AGENT_ACCOUNT` | demo step 5                                             |

Send the agent native USDC (`17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`) and 0.2 NEAR;
`live-setup.mjs --deposit all` (step 2) moves the USDC into its NEAR Intents balance.

**2. Bring the stack up in live mode**

```sh
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0               # Macs with corepack: pnpm never waits on a download prompt
cd ../nearpay-deploy
$EDITOR compose/env/local.env                          # accounts and RPCs from the table
scripts/seed.sh live                                   # validates .secrets/live/*, writes .secrets/live/compose.live.yaml
pnpm -C scripts/live-setup install --frozen-lockfile   # once
node scripts/live-setup.mjs                            # dry run: on-chain status, who to fund and how much
node scripts/live-setup.mjs --apply --deposit all      # relayer keys on intents.near + agent USDC deposit (asks y/N)
scripts/up.sh local                                    # includes the live overlay automatically
cd ../nearpay-testbed
```

`up.sh` builds nearpay-js, nearpay-checkout and nearpay-dashboard itself when their `dist/` is missing or older
than the repo's HEAD (`--build-sites` forces it); no manual `pnpm build` is needed.

`NP_ENV` stays `local`: the stack runs on your machine, and the local Turnstile test keys stay in place.
A public deployment needs real Turnstile keys and `NP_ENV=server` (Stage 5).

**3. Demo script** (from this repo)

```sh
export NODE_EXTRA_CA_CERTS=../nearpay-deploy/.secrets/tls/ca.pem   # Node trusts the local stack's TLS CA
```

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
     that key, so payouts go to it; then skips the cool-off when the stack has one (`NP_COOLOFF_SECONDS` > 0) and submits self-declared business details
     (`--country`, default GB; no registration number) — compliance decides at once (open onboarding,
     ADR-0024). Only `--kyb-mode manual` (stack on `NP_KYB_MODE=manual`) approves KYB through the ops CLI;
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
   - Save your business details in **Settings → Business details** — live mode turns on at once.
   - Then run, from this repo:

     ```sh
     pnpm ops destination-cooloff-skip sd_…                       # only when the stack sets NP_COOLOFF_SECONDS > 0
     # only when compliance runs NP_KYB_MODE=manual:
     pnpm ops kyb-decide acct_… approved --reason "demo merchant"
     ```
   - The account shows **Live**. In **Developers**:
     - create a live secret key and write it to `../nearpay-deploy/.secrets/merchant-demo/secret_key`;
     - add a live webhook endpoint `http://merchant-demo:3000/webhooks` (allowed only while `NP_ENV=local`) and append its signing secret to `.secrets/merchant-demo/webhook_secret`, comma-separated.
   - merchant-demo re-reads both files within 5 s.
2. **Checkout session.** Run `pnpm demo:checkout`. It prints a live hosted-checkout URL (USD 2.00).
3. **Payer pays.** Open the URL. Check the merchant name and the destination fingerprint (checkout shows payment instructions only after sentinel's co-signature verifies). Connect the EVM wallet, choose USDC on Base, and pay.
4. **Settlement.** Within about 1–2 minutes the merchant's Intents balance shows 2.00 USDC. `demo:checkout` prints `payment_intent.succeeded`, verified by merchant-demo. The dashboard payment page links the on-chain evidence.
5. **Agent payment.** Run:

   ```sh
   NP_AGENT_SECRET_KEY_FILE=… NP_AGENT_ACCOUNT=… pnpm demo:agent --live
   ```

   The agent gets `402`, signs a NEAR Intents transfer, and receives the resource with `PAYMENT-RESPONSE` in about 2 s. merchant-demo receives `agent_payment.settled`. The price is 0.01 USDC, paid to the merchant's active Intents-account destination for its asset.

**Safety.**

- Live keys and `.secrets/` never leave your machine and are never committed.
- `pnpm ops kill-switch-engage <reason>` pauses rails and agentpay at once if anything looks wrong (`pnpm ops kill-switch` shows the state).
- A sentinel integrity refusal on one payment quarantines that merchant for 30 minutes by default; other merchants keep
  working. Sentinel engages the global kill switch itself only on corroborated refusals across merchants (ADR-0028). After
  an engaged switch has been checked, resume with `pnpm ops kill-switch-release "<what was checked>" --yes` (local stacks).
- Stop with `scripts/down.sh` in nearpay-deploy.

## Status

Step 1.3: merchant-demo, demo scripts, Stage 1 ops CLI and E2E scaffolding with unit + mock-backed
tests. Step 1.4: every suite above green against the full Compose stack in test mode (traces T1–T7,
sandbox scenarios 00–07). Later steps added the Stage 2 (refunds, payment links, reconciliation, console), Stage 3
(invoices, subscriptions, events stream, agents, CLI) and Stage 4 (mandates on the sandbox vault stand-in, Solana and
Bitcoin) suites listed above, and the open-onboarding flow (ADR-0024). Current pins (`package.json`):
`@nearpay-money/spec` 0.5.0, `@nearpay-money/x402` and `@nearpay-money/agent-signer` 0.3.0, `@nearpay-money/node` 0.4.0.

## Built with

- Runtime: Express (merchant-demo), zod, `@nearpay-money/spec`, `@nearpay-money/node`, `@nearpay-money/x402`,
  `@nearpay-money/agent-signer`.
- Development: TypeScript, Vitest, Playwright, Biome, tsx, `@noble/curves`, canonicalize, `@nearpay-internal/intents`
  and `@nearpay-internal/spec` (scripted payers and event checks).
- Licence: Apache-2.0 (`LICENSE`).

Code and documentation are written with AI assistance (Claude) under human direction and review. Built for the NEAR Hackathon (Nov 2026).
