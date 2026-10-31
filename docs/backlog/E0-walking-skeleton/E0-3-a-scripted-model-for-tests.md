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

- Tier 2: a scripted `LanguageModel` layer that replays turns, including tool calls. No HTTP
- Tiers 3 and 4: a mock model server that replays the same scripts over HTTP, in the API shapes our
  runtimes need: Anthropic Messages (Claude Code over ACP), OpenAI Chat Completions and Responses (Codex,
  `openai`, `openai-compat`)
- `api` points at it through the provider's base URL in `Config`; each ACP CLI through its own base URL variable
- One nightly smoke test against a real model

Out:

- Recording real conversations as fixtures (later, if useful)

## Demo

1. Run `vp test run` with no network and no API key.
2. The E0-1 tier-2 and tier-4 tests pass.

## Layers

server · infra

## Audit

None.

## Telemetry

None.

## Tests

- Tier 2: a scripted tool call reaches the `Toolkit` handler with the scripted input.
- Tier 3: the same script gives the same tool call through the mock server in each API shape.

## Reference

OpenBot uses `@copilotkit/aimock`. Check which API shapes it covers before writing our own.
