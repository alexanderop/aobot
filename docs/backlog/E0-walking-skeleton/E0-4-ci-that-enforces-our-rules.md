---
id: E0-4
title: CI that enforces our rules
epic: E0
status: todo
depends_on: [E0-1]
estimate: 1d
---

# E0-4 · CI that enforces our rules

**Story:** As a developer, I get a failing pull request when I break one of our rules, instead of a review comment.

## Scope

In:

- GitHub Actions: typecheck, type-aware `oxlint`, `knip`, tests tiers 1–3
- Lint rule: no `process.env` outside `Config` layers
- Lint rule: only the gateway imports the computer client (active once E1-1 lands)
- Workflows pass `zizmor --persona pedantic`

Out:

- Tier-4 tests in CI (they need Docker; nightly job later)

## Demo

1. Open a pull request that reads `process.env.FOO` in a server service.
2. CI fails and names the rule.

## Layers

infra

## Audit

None.

## Telemetry

None.

## Tests

- The CI run itself is the test.
