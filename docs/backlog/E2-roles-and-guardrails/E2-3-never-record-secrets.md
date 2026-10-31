---
id: E2-3
title: Never record secrets
description: As security, I know nothing a Bot typed, and no password a person gave it, ends up in the chat, the audit trail or telemetry.
epic: E2
status: todo
depends_on: [E1-2]
estimate: 2d
---

# E2-3 · Never record secrets

**Story:** As security, I know nothing a Bot typed, and no password a person gave it, ends up in the chat, the audit trail or telemetry.

## Scope

In:

- `redact()` replaces typed text with `[N chars]` in audit rows and span attributes
- One shared function, used by both
- `request_secret` tool: the Bot names the field it needs; the chat shows a secret input outside the
  conversation; the value goes from the server straight to the computer and types into that ref. The
  model never sees it, the transcript never stores it
- A credential in a URL's query or fragment (`?token=`, `#access_token=`) is refused or redacted, whatever the field is called
- Redaction matches key names in every spelling (`toolResult`, `tool_result`)

Out:

- A stored password vault (later)

## Demo

1. Ask the Bot to type `hunter2-secret` into a search box.
2. The audit row shows `"text":"[14 chars]"`.
3. Ask the Bot to sign into the local login fixture. It asks for the password; type it into the secret field.
4. The Bot is signed in. No audit row, span, stored message or model request contains either secret.

## Layers

web · server · gateway · computer

## Audit

`type · allow` with redacted text, `secret.requested`, `secret.supplied` with the length only.

## Telemetry

Redacted text only.

## Tests

- Tier 1: `redact()` cases.
- Tier 2: the gateway with an in-memory tracer and audit; neither contains the secret.
- Tier 4: the demo, searching the database, the trace export and the mock model's request log for both secrets.
- Tier 1: `redact()` on a URL with `?access_token=abc` and on camelCase and snake_case keys.

## Reference

OpenBot `docs/architecture.md` § Human control and secrets.
OpenBot #230 and #329.
