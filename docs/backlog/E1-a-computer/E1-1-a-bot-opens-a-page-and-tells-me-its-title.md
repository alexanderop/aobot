---
id: E1-1
title: A Bot opens a page and tells me its title
epic: E1
status: todo
depends_on: [E0-3]
estimate: 3d
---

# E1-1 · A Bot opens a page and tells me its title

**Story:** As a person, I ask a Bot to open a page and it tells me what is on it, and the action is recorded.

## Scope

In:

- `apps/computer`: Node + Playwright in Docker, `POST /act` for `navigate` and `snapshot`, bearer token, `/health`
- Snapshot as `ariaSnapshot({ mode: "ai" })`, capped at 12,000 characters with `truncated: true`
- `Computers` service with the `docker` provider: `ensure`, `stop`, `reset`, `list`. One shared computer for now
- Gateway: allow everything for now, but write an audit row for every call, with `trace_id`
- `traceparent` sent to the computer

Out:

- Click, type, shell (E1-2, E1-3)
- Grants and rules (E2)
- One computer per person (E3-3)

## Demo

1. Ask: "Open example.com and tell me the page title."
2. The Bot answers "Example Domain".
3. The audit table has `navigate · allow` and `snapshot · allow`, each with a `trace_id`.

## Layers

server · gateway · computer · database · infra

## Audit

`navigate · allow`, `snapshot · allow`.

## Telemetry

`Gateway.act` spans inside `Chat.turn`, with the computer's work inside them.

## Tests

- Tier 1: snapshot capping.
- Tier 2: gateway with a fake computer writes one row per call, also on computer failure.
- Tier 3: contract suite v1 against `docker`: navigate a local HTML fixture, refs present, 401 without token.
- Tier 4: the demo.

## Reference

OpenBot `agent-computer/src/index.ts`, `aria-snapshot.ts`.
