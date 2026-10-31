---
id: E4-1
title: The desktop app
description: As a colleague, I install aobot as an app, sign in once, and it remembers me.
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
- Sign-in hand-off: PKCE, a `state` value, a redirect only to `127.0.0.1` on a fixed path, and a single-use code that expires in 120 seconds

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
- Tier 2: a reused or expired code, a wrong `state` and a non-loopback redirect are all refused.

## Reference

- t3code `apps/desktop` is an Effect + Electron reference.
- OpenBot `server/src/auth/native-browser.ts`.
