---
id: E2-3
title: Never record secrets
epic: E2
status: todo
depends_on: [E1-2]
estimate: 1d
---

# E2-3 · Never record secrets

**Story:** As security, I know nothing a Bot typed ends up in the audit trail or in telemetry.

## Scope

In:

- `redact()` replaces typed text with `[N chars]` in audit rows and span attributes
- One shared function, used by both

Out:

- Nothing excluded.

## Demo

1. Ask the Bot to type `hunter2-secret` into a search box.
2. The audit row shows `"text":"[14 chars]"`.
3. No audit row and no span contains `hunter2`.

## Layers

gateway · server

## Audit

`type · allow` with redacted text.

## Telemetry

Redacted text only.

## Tests

- Tier 1: `redact()` cases.
- Tier 2: the gateway with an in-memory tracer and audit; neither contains the secret.
