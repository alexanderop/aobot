---
id: E2-5
title: Ask before risky actions
epic: E2
status: todo
depends_on: [E2-2]
estimate: 2d
---

# E2-5 · Ask before risky actions

**Story:** As a person, my Bot asks me before a risky action, in the chat, and only acts when I say yes.

## Scope

In:

- A rule can answer `ask` as well as `allow` and `deny`
- The turn pauses and the question appears as an approval card in the chat ([design.md](../../design.md)): the question, then lettered answer rows
- The answer is recorded: who answered, which option, when
- No answer within a time limit counts as no

Out:

- Approvals by someone other than the person in the chat (later)

## Demo

1. Add a rule: `ask` when the Bot runs a command containing `delete`.
2. Ask the Bot to delete a file in its workspace.
3. An approval card appears. Answer "No": the file stays.
4. Ask again and answer "Yes": the file is gone.

## Layers

web · server · gateway

## Audit

`run · ask`, then `approval.answered` with the answer, then `run · allow` or `run · deny`.

## Telemetry

The wait as a span with the answer as an attribute.

## Tests

- Tier 1: rule cases that return `ask`.
- Tier 2: the turn waits, then resumes or refuses; a timeout counts as no (`TestClock`).
- Tier 4: the demo.

## Reference

OpenBot approval rules (`server/src/approvals/`) and `useHumanInTheLoop` in its app.
