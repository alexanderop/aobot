---
id: E2-7
title: Pause a Bot
description: As a person, I press Stop and my Bot stops now. As an admin, I pause a Bot and none of its turns run anywhere until I resume it.
epic: E2
status: todo
depends_on: [E2-1]
estimate: 2d
---

# E2-7 · Pause a Bot

**Story:** As a person, I press Stop and my Bot stops now. As an admin, I pause a Bot and none of its turns run anywhere until I resume it.

## Scope

In:

- A Stop button in the composer while a turn runs: cancels the turn, its running tool call and the model stream
- Pause a Bot (admin): stored in the database; turns on this replica are cancelled at once, other replicas check every 5 seconds and cancel theirs
- A replica that cannot read the pause state three times in a row refuses new turns for that Bot (fail closed)
- Every turn, including ones nobody typed, checks the pause before it starts

Out:

- Pausing every Bot at once with one switch (later, with admin controls)

## Demo

1. Ask a Bot to open ten pages one by one. Press Stop after the second: it stops, and no third `navigate` row appears.
2. Pause the Bot as admin. Send it a message: "This Bot is paused."
3. Resume it. It answers again.

## Layers

web · server · gateway · database

## Audit

`turn.stopped` with who stopped it, `bot.paused`, `bot.resumed`, refused turns as `deny · bot paused`.

## Telemetry

Cancelled turns end their `Chat.turn` span with status `cancelled`.

## Tests

- Tier 2: a pause on replica A cancels a turn on replica B within 5 seconds (`TestClock`, two server layers on one database).
- Tier 2: three failed reads of the pause state refuse new turns.
- Tier 4: the demo.

## Reference

- OpenBot `server/src/agents/lifecycle.ts` (`pause`, `CROSS_REPLICA_CHECK_MS`, `guardBotTurn`).
