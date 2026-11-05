# nearpay-testbed

> Whole-system verification and demos: merchant-demo app, demo scripts (checkout, agent), Stage 1 ops CLI, cross-service E2E, consumer-driven contract tests, load tests (k6), chaos scenarios, mainnet canary runner, recorded provider fixtures.

| | |
|---|---|
| Group | Platform |
| Kind | tests |
| Ships as | CI + scheduled jobs |
| Owns | System tests |
| Depends on (published artifacts only) | all published artifacts |
| First built in | Stage 1 (steps 1.3–1.5) |

## Documentation

This repo stays surgical: design docs live in [`nearpay-brain`](../nearpay-brain/README.md), not here.

- `nearpay-brain/lld/platform.md` — **low-level design (dev-ready; implement from this)**
- `nearpay-brain/lld/audits/platform.md` — audit findings already folded into the LLD
- `nearpay-brain/roadmap/development-plan.md` — stage and step this repo is built in
- `nearpay-brain/architecture/hld.md` — system design
- `nearpay-brain/architecture/repositories.md` — repo topology and dependency rules
- `nearpay-brain/quality/stress-test.md`
- `nearpay-brain/quality/capacity.md`

## Layout

```
nearpay-testbed/
├── canary/
├── chaos/
├── compose/
├── contract-tests/
├── demo/
├── e2e/
│   ├── agent/
│   ├── api/
│   ├── checkout/
│   └── dashboard/
├── fixtures/
│   ├── near/
│   └── oneclick/
├── load/
├── merchant-demo/
├── ops/
└── .github/
    └── workflows/
```

## Status

Scaffold only. Implementation starts in **Stage 1 (steps 1.3–1.5)** (`nearpay-brain/roadmap/development-plan.md`).

## Built with

Libraries are listed here as they are added (hackathon rule Q-005). Code and documentation are written with AI assistance (Claude) under human direction and review.
