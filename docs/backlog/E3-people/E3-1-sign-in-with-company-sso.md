---
id: E3-1
title: Sign in with company SSO
description: As a colleague, I sign in with my company account and the audit trail shows it was me.
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
- An explicit single-user dev mode that is off unless set. With it on, the server refuses to start if its
  public URL resolves to a public address, and warns naming a private one
- Signing in, being refused and being made an administrator by configuration each write an audit row
- Removing a person deletes their sessions and blocks their address, because the next SSO sign-in would
  otherwise recreate them
- Sign-in only for allowed email domains (`SIGNIN_ALLOWED_EMAIL_DOMAINS`), checked before a user row is created and again at every new session
- Removing a person also stops their computer (E3-3) and retires credentials they gave the deployment, in one step
- The single-user and production checks look at the address, never at `NODE_ENV`; `.env.example` ships no unsafe switch turned on

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

Actor is the signed-in person. `auth.signed_in`, `auth.refused`, `auth.admin_granted`, `person.removed`.

## Telemetry

`actor.id` on `Chat.turn`.

## Tests

- Tier 2: requests without a session are refused.
- Tier 2: single-user mode with a public URL fails start-up; with `192.168.1.5` it starts and warns.
- Tier 2: a removed person signing in again is refused.
- Tier 4: the demo.
- Tier 2: `mallory@other.com` is refused before a user row exists; removing a domain stops its next sign-in.

## Reference

- OpenBot README § Sign-in.
- OpenBot #622 (gate on the address, not `NODE_ENV`), `server/src/auth/email-domain.ts`, `admin/controls.ts` (`offboard`).
