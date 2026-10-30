---
id: E4-1
title: The desktop app
epic: E4
status: todo
depends_on: [E3-1]
estimate: 3d
---

# E4-1 · The desktop app

**Story:** As a colleague, I install aobot as an app, sign in once, and it remembers me.

## Scope

In:

- Electron app that loads the web app
- Server address configurable (local or AWS)
- Sign-in through the system browser; token kept with Electron `safeStorage`
- Signed builds are a later ticket

Out:

- Auto-update, code signing (later)

## Demo

1. Start the app pointed at the local server.
2. Sign in through the browser.
3. Quit and restart: still signed in.

## Layers

desktop · web

## Audit

None new.

## Telemetry

App version as a resource attribute on traces.

## Tests

- Tier 4: launch the app headless and complete the demo.

## Reference

t3code `apps/desktop` is an Effect + Electron reference.
