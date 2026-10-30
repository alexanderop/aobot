---
id: E0-4
title: Quality gates and CI
epic: E0
status: doing
depends_on: [E0-1]
estimate: 2d
---

# E0-4 · Quality gates and CI

> **Progress:** `bun run check` and every plugin are in place and green locally. Left: the CI run on GitHub (needs the remote) and the `verify` scenario for this ticket's demo.

**Story:** As a developer, I get a failing pull request when I break one of our rules, instead of a review comment.

## Scope

In:

- Everything in [quality-gates.md](../../quality-gates.md): strict `tsconfig`, `bun run check`, `knip`
- `oxlint --deny-warnings` with `anti-slop` and `anti-slop-effect` vendored from dmmulroy/anti-slop, `aobot-standards` copied from effect-factory, `aobot-architecture` with our dependency graph
- Vitest project `architecture` that tests the custom lint rules and that the graph is acyclic
- Restricted imports and globals: no `process.env` outside config, gateway-only computer client (active once E1-1 lands), no `console` in the server
- GitHub Actions runs `bun run check`; workflows pass `zizmor --persona pedantic`
- `CLAUDE.md` with `AGENTS.md` symlinked, listing the commands

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
