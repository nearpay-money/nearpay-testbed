# nearpay-testbed

> Whole-system verification: local compose stack, cross-service E2E, consumer-driven contract tests, load tests (k6), chaos scenarios, mainnet canary runner, recorded provider fixtures.

| | |
|---|---|
| Group | Platform |
| Kind | tests |
| Ships as | CI + scheduled jobs |
| Owns | System tests |
| Depends on (published artifacts only) | all published artifacts |
| Roadmap phase | P0 Foundations |

## Documentation

This repo stays surgical: design docs live in [`nearpay-brain`](../nearpay-brain/README.md), not here.

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
├── e2e/
│   ├── agent/
│   ├── api/
│   ├── checkout/
│   └── dashboard/
├── fixtures/
│   └── oneclick/
├── load/
└── .github/
    └── workflows/
```

## Status

Scaffold only. Implementation starts in phase **P0 Foundations** (`nearpay-brain/roadmap/roadmap.md`).
