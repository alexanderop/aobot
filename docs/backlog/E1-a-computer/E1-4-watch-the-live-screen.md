---
id: E1-4
title: Watch the live screen
description: As a person, I watch my Bot's browser while it works.
epic: E1
status: todo
depends_on: [E1-1]
estimate: 2d
---

# E1-4 · Watch the live screen

**Story:** As a person, I watch my Bot's browser while it works.

## Scope

In:

- Chrome DevTools `Page.startScreencast` in the computer, frames over a WebSocket
- The server relays frames to the page; the computer's token never reaches the browser
- The screen is a side panel beside the chat that folds away when the Bot is idle ([design.md](../../design.md))

Out:

- Taking control (E1-5)

## Demo

1. Open the chat, ask the Bot to open example.com.
2. The screen shows the page while the Bot works.

## Layers

web · server · computer

## Audit

None.

## Telemetry

None.

## Tests

- Tier 3: `/stream` refuses without a token.
- Tier 4: the screen image is non-empty after navigation.

## Reference

OpenBot `agent-computer/src/screencast.ts`.
