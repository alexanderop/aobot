---
id: E3-4
title: Idle computers stop by themselves
epic: E3
status: todo
depends_on: [E3-3]
estimate: 2d
---

# E3-4 · Idle computers stop by themselves

**Story:** As the person paying the bill, computers nobody uses stop, and come back with their logins when needed.

## Scope

In:

- Idle is decided from the audit trail, not by asking the browser (asking would wake it)
- A sweep claims work from Postgres with `select … for update skip locked`, so only one server replica acts
- `ensure` resumes a stopped computer transparently

Out:

- Nothing excluded.

## Demo

1. Set the idle limit to 2 minutes in dev.
2. Use a Bot, wait 3 minutes: its container is stopped.
3. Ask the Bot something: the computer starts and it is still signed in.

## Layers

server · computer · database

## Audit

`computer.stopped` and `computer.started` rows, initiator `deployment`.

## Telemetry

Sweep spans.

## Tests

- Tier 2: idle decision with `TestClock`.
- Tier 2: two concurrent sweeps stop a computer once.
- Tier 4: the demo.

## Reference

OpenBot `charts/openbot/README.md` § A computer for each Bot (the culler).
