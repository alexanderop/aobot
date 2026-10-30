---
id: E0-3
title: A scripted model for tests
epic: E0
status: todo
depends_on: [E0-1]
estimate: 1d
---

# E0-3 · A scripted model for tests

**Story:** As a developer, I run every test without a real model, so tests are fast, free and give the same result every time.

## Scope

In:

- A mock model server that speaks the Anthropic Messages API and replays scripted turns, including `tool_use` blocks
- Tests point the Agent SDK at it with `ANTHROPIC_BASE_URL`
- One nightly smoke test against the real model

Out:

- Recording real conversations as fixtures (later, if useful)

## Demo

1. Run `bun test` with no network and no API key.
2. The E0-1 tier-2 and tier-4 tests pass.

## Layers

server · infra

## Audit

None.

## Telemetry

None.

## Tests

- Tier 2: a scripted `tool_use` turn reaches the tool handler with the scripted input.

## Reference

OpenBot uses `@copilotkit/aimock`. Check whether it covers the Anthropic Messages API before writing our own.
