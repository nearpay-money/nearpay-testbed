# AGENTS.md — nearpay-testbed

You are working in **nearpay-testbed**, one of 26 NearPay repositories (`nearpay-brain/architecture/repositories.md`).
Scope: Whole-system verification and demos: merchant-demo app, demo scripts (checkout, agent), Stage 1 ops CLI, cross-service E2E, consumer-driven contract tests, load tests (k6), chaos scenarios, mainnet canary runner, recorded provider fixtures.

## Before changing anything

1. Read `../nearpay-brain/AGENTS.md`, then this repo's LLD (`../nearpay-brain/lld/platform.md`) — it is the implementation spec; do not make design decisions it already makes.
2. Contracts (requests, responses, events, errors) come from `@nearpay-money/spec`. If one must change, open a PR in `nearpay-spec` first; never hand-write contract types here.
3. Check your change against invariants INV-1…INV-9 in `nearpay-brain/product/requirements.md`.

## Rules for this repo

- Tests use only published artifacts and public/internal APIs; never reach into service databases.
- Canary runner budget is capped in config; never raise it without approval.

## Never

- Import source code from another NearPay repo (depend on published packages/images only).
- Read or write another service's database.
- Add design documents here — update `nearpay-brain` and link to it.
- Commit secrets, private keys or real customer data.
- Merge changes to paths listed in `.github/CODEOWNERS` without the required human review.
