---
id: E1-5
title: Take control and hand back
epic: E1
status: todo
depends_on: [E1-4]
estimate: 2d
---

# E1-5 · Take control and hand back

**Story:** As a person, I take the mouse when my Bot reaches a login or a CAPTCHA, then hand it back.

## Scope

In:

- `holder` is `bot` or `person`; while a person holds it, the Bot's actions are refused with a clear message
- Clicks on the screen image are scaled to the viewport and sent to the computer
- `control_taken` and `control_released` audit rows

Out:

- The Bot asking for help on its own (E4-2)

## Demo

1. Click "Take control".
2. Ask the Bot to navigate: it replies that a person has control.
3. Click a link on the screen yourself.
4. Hand back. The Bot continues.

## Layers

web · server · gateway · computer

## Audit

`control_taken`, the refused Bot call, `control_released`.

## Telemetry

Control events as span events.

## Tests

- Tier 2: gateway refuses while a person holds control.
- Tier 4: the demo.

## Reference

OpenBot `agent-computer/src/control.ts`.
