---
id: E3-2
title: My conversations, only mine
description: As a colleague, I see and continue my own conversations, and nobody else's.
epic: E3
status: todo
depends_on: [E3-1]
estimate: 2d
---

# E3-2 · My conversations, only mine

**Story:** As a colleague, I see and continue my own conversations, and nobody else's.

## Scope

In:

- Conversations list per person
- Continue a conversation from our stored messages (`effect/ai` `Chat` rebuilt from the database; for `acp`,
  `session/load` where the CLI supports it, else a fresh session primed with the history)
- Every conversation route checks ownership
- Last-message previews and unread dots in the sidebar

Out:

- Shared or group conversations (later)

## Demo

1. Alice starts two conversations; Bob signs in and sees none.
2. Alice reloads and continues the first one; the Bot remembers it.

## Layers

web · server · database

## Audit

None new.

## Telemetry

None new.

## Tests

- Tier 2: Bob reading Alice's conversation is refused.
- Tier 4: the demo.

## Reference

OpenBot channel memberships in `docs/architecture.md`.
