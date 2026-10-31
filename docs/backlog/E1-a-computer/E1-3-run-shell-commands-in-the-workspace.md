---
id: E1-3
title: Run shell commands in the workspace
description: As a person, I ask a Bot to create and read files, and it uses its own folder.
epic: E1
status: todo
depends_on: [E1-1]
estimate: 1d
---

# E1-3 · Run shell commands in the workspace

**Story:** As a person, I ask a Bot to create and read files, and it uses its own folder.

## Scope

In:

- `run` tool: `bash -c` in `/workspace`, 30-second timeout, output tails capped
- Commands get PATH, locale and proxy variables only, never the computer's own environment
- Command output reaches the model as untrusted data
- Commands run as the image's non-root user
- A Stop that arrives before the command has started is still honoured

Out:

- Network limits (E5-3)

## Demo

1. Ask: "Create notes.txt containing hello, then list the folder."
2. The Bot shows `notes.txt`.

## Layers

gateway · computer

## Audit

`run · allow` with the command.

## Telemetry

`Gateway.act` span with exit code as an attribute.

## Tests

- Tier 3: timeout kills the command; `env` output does not contain `COMPUTER_TOKEN`.
- Tier 4: `ls /data/aobot.db` and `curl -m 3 http://server:3000` from the Bot's shell both fail.
- Tier 4: the demo.
- Tier 3: Stop sent before spawn means the command never runs.

## Reference

- OpenBot `agent-computer/src/shell.ts`.
- OpenBot #733 (a Stop that already landed).
