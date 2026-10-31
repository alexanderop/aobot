---
id: E2-2
title: Rules that fail closed
description: As security, I write deny and allow rules over tool, page, command and Bot, and anything unclear is refused.
epic: E2
status: todo
depends_on: [E2-1]
estimate: 4d
---

# E2-2 · Rules that fail closed

**Story:** As security, I write deny and allow rules over tool, page, command and Bot, and anything unclear is refused.

## Scope

In:

- Rule language chosen in this ticket (OpenBot uses CEL through `cel-js`)
- Fields: `tool.name`, `bot.id`, `actor.id`, `page.host`, `command`
- Deny rules first; then an allow rule must match; a crashing deny rule denies; a crashing allow rule allows nothing
- A malformed rule file stops startup
- More fields: `element.role` and `element.name` from the server's snapshot (never from what the Bot claims), `key` for key presses, `computer.kind`
- Every field is bound on every action, so a rule never throws on a missing name; a ref that cannot be resolved is refused, not judged on an empty element

Out:

- Editing rules in the UI (later)

## Demo

1. Ask the Assistant to run `rm -rf /tmp/x`.
2. It reports the refusal and names the rule `no-rm-rf`.

## Layers

server · gateway

## Audit

`run · deny · no-rm-rf`.

## Telemetry

Decision and rule name as span attributes.

## Tests

- Tier 1: a table of rule cases, including crashing rules and empty policy.
- Tier 4: the demo.
- Tier 1: a rule denying a click on "Submit" also catches pressing Enter in that form through a `key` rule.

## Reference

OpenBot `docs/architecture.md` § Browser action governance.
