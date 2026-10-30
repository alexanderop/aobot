---
id: E2-1
title: Bots from a file, with granted tools
epic: E2
status: todo
depends_on: [E1-3]
estimate: 2d
---

# E2-1 · Bots from a file, with granted tools

**Story:** As an admin, I define Bots in `bots.yaml` and each one can only use the tools I granted.

## Scope

In:

- `bots.yaml` decoded with Effect Schema at boot; an invalid file stops startup with the reason
- Bot picker in the web page
- The gateway checks the grant before any rule; a refusal reads `not granted to <bot>`

Out:

- Creating Bots in the UI (later)

## Demo

1. Pick Researcher (granted: snapshot, navigate, click).
2. Ask it to run `ls`.
3. It reports the refusal; the audit row says `not granted to researcher`.

## Layers

web · server · gateway

## Audit

`run · deny · not granted to researcher`.

## Telemetry

None new.

## Tests

- Tier 1: grant check table tests.
- Tier 2: gateway refuses before calling the policy.
- Tier 4: the demo.

## Reference

Decision 7 in [architecture.md](../../architecture.md#decisions).
