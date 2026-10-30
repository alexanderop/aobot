---
id: E3-1
title: Sign in with company SSO
epic: E3
status: todo
depends_on: [E2-1]
estimate: 3d
---

# E3-1 · Sign in with company SSO

**Story:** As a colleague, I sign in with my company account and the audit trail shows it was me.

## Scope

In:

- OIDC sign-in (library chosen in this ticket; OpenBot uses `better-auth`)
- A local OIDC provider in Compose for development and tests
- `actor.id` on audit rows is the signed-in person
- An explicit single-user dev mode that is off unless set

Out:

- Roles and admin pages (later)
- SCIM (later)

## Demo

1. Open the app signed out: it asks to sign in.
2. Sign in as alice in the local provider.
3. Run any Bot action: the audit row's actor is alice.

## Layers

web · server · infra

## Audit

Actor is the signed-in person.

## Telemetry

`actor.id` on `Chat.turn`.

## Tests

- Tier 2: requests without a session are refused.
- Tier 4: the demo.

## Reference

OpenBot README § Sign-in.
