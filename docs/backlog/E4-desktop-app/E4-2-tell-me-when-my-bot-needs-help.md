---
id: E4-2
title: Tell me when my Bot needs help
epic: E4
status: todo
depends_on: [E4-1, E1-5]
estimate: 2d
---

# E4-2 · Tell me when my Bot needs help

**Story:** As a colleague, I get a notification when my Bot is stuck at a login, and one click takes me to its screen.

## Scope

In:

- `request_help` tool: the Bot pauses and records the page it is on
- Desktop notification; clicking opens the live screen with Take control ready
- The Bot resumes when control is handed back

Out:

- Nothing excluded.

## Demo

1. Ask the Bot to sign into a test site that needs a code.
2. A notification appears.
3. Click it, enter the code, hand back. The Bot finishes.

## Layers

desktop · server · gateway

## Audit

`help_requested`, `control_taken`, `control_released`.

## Telemetry

Help request as a span event.

## Tests

- Tier 2: the turn waits on the handover and resumes.
- Tier 4: the demo.

## Reference

OpenBot `computer.help_requested` in `docs/architecture.md`.
