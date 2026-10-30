---
id: E3-3
title: One computer per person
epic: E3
status: todo
depends_on: [E3-1]
estimate: 3d
---

# E3-3 · One computer per person

**Story:** As a colleague, my Bots use my own computer, so my logins and files are never shared.

## Scope

In:

- The `docker` provider ensures one container per person, with a named volume for browser profiles and `/workspace`
- Inside it, one browser profile and folder per Bot
- The gateway resolves the computer from the signed-in person

Out:

- Stopping idle computers (E3-4)

## Demo

1. Alice's Bot signs into a test site.
2. Bob's Bot opens the same site: it is signed out.
3. Alice's Bot, after a restart of her computer, is still signed in.

## Layers

server · computer · infra

## Audit

Rows name the person and the Bot.

## Telemetry

Computer id as a span attribute.

## Tests

- Tier 3: contract suite gains isolation cases (files and cookies).
- Tier 4: the demo.

## Reference

OpenBot `supervisor/`, `agent-computer/src/profiles.ts`.
