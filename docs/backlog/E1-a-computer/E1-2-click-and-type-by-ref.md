---
id: E1-2
title: Click and type by ref
epic: E1
status: done
depends_on: [E1-1]
estimate: 2d
---

# E1-2 · Click and type by ref

**Story:** As a person, I ask a Bot to fill in a form and it clicks and types like I would.

## Scope

In:

- `click` and `type` tools using the `aria-ref=<ref>` locator
- Refs only valid for the latest snapshot; a stale ref returns a clear error telling the Bot to snapshot again
- Every action returns a fresh snapshot
- The latest snapshot per Bot is stored server-side in the database, so any replica can resolve a ref. The gateway resolves a ref to its role and name before rules run and refuses a ref it cannot resolve

Out:

- Secret redaction (E2-3)

## Demo

1. Ask the Bot to search Wikipedia for "Effect TypeScript" without submitting.
2. The search box holds the text.
3. The audit table shows `type` and `click` rows.

## Layers

gateway · computer

## Audit

`click · allow`, `type · allow`.

## Telemetry

One `Gateway.act` span per action.

## Tests

- Tier 3: click and type against a local form fixture; a stale ref fails with the documented error.
- Tier 4: the demo.
- Tier 2: a click on a ref missing from the stored snapshot is refused before any rule runs.

## Reference

OpenBot `agent-computer/src/index.ts` (`aria-ref`), `enter-text.ts`.
