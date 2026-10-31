---
id: E2-6
title: Some actions are always the person's
epic: E2
status: todo
depends_on: [E2-5]
estimate: 2d
---

# E2-6 · Some actions are always the person's

**Story:** As security, I know a Bot never changes a password, a security setting or pays for something on its own, even if a rule says `allow`.

## Scope

In:

- A fixed safety list checked before any rule: entering or changing credentials, security settings (2FA, recovery codes, API keys), and payments or purchases
- A match hands the action to the person: the Bot stops, asks for help, and the person does it themselves in the live screen (E1-5)
- Matching uses the resolved element and page (role, name, URL), never the text the Bot typed
- Reads and workspace tools are exempt
- The list is code, not configuration: no rule and no admin setting turns it off

Out:

- Editing the list in the UI (never)

## Demo

1. Add the rule `allow: true`.
2. Ask the Bot to change the password on the local account fixture.
3. It stops and asks you to take control; the audit row names the safety list, not a rule.

## Layers

server · gateway

## Audit

`click · hand_off · safety:credentials`.

## Telemetry

`decision.source = safety` as a span attribute.

## Tests

- Tier 1: a table of pages and elements that must hand off (change password, add card, "Buy now") and ones that must not (search, read an order).
- Tier 2: with `allow: true`, a safety match still hands off.
- Tier 4: the demo.

## Reference

- OpenBot `server/src/approvals/policy.ts` (`SAFETY_REQUIREMENTS`, checked first in `decideAction()`).
