---
id: E1-5
title: Take control and hand back
epic: E1
status: done
depends_on: [E1-4]
estimate: 3d
---

# E1-5 · Take control and hand back

**Story:** As a person, I take the mouse when my Bot reaches a login or a CAPTCHA, then hand it back.

## Scope

In:

- `holder` is `bot` or `person`; while a person holds it, the Bot's actions are refused with a clear message
- Clicks on the screen image are scaled to the viewport and sent to the computer
- `control_taken` and `control_released` audit rows
- "A person has control" is decided in one place, the gateway's dispatcher, for every acting tool, not in each handler
- Taking control first closes the door to new Bot actions, then waits for actions already running to finish
- The holder is stored, so a restart never hands control back to the Bot by itself
- After hand back, the Bot must take a fresh snapshot before it acts; old refs are refused

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
- Tier 1: every acting tool in the registry goes through the control check (a new tool cannot skip it).
- Tier 2: a click admitted just before Take control finishes before the person gets the screen; after a restart the person still holds control.

## Reference

- OpenBot `agent-computer/src/control.ts`.
- OpenBot #247 (shell and file writes skipped the check), `agent-computer/src/control.ts`, `action-barrier.ts`, `control-store.ts`.
