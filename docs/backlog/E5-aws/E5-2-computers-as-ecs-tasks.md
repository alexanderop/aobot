---
id: E5-2
title: Computers as ECS tasks
epic: E5
status: todo
depends_on: [E5-1, E3-3]
estimate: 4d
---

# E5-2 · Computers as ECS tasks

**Story:** As a colleague, my computer runs in AWS and keeps my logins, so the Bot works while my laptop is closed.

## Scope

In:

- `ecs` provider: `RunTask` per person in a private subnet, wait for health, reach it by private IP
- Persistent browser profile and `/workspace` (EFS, or decided in this ticket)
- Chromium launched with `--disable-dev-shm-usage` (Fargate has no shared-memory setting)
- Passes the full contract suite

Out:

- Kubernetes (E5-4)

## Demo

1. Set `COMPUTER_PROVIDER=ecs`.
2. Run the E1 demos against AWS.
3. Stop the task; the next request starts a new one, still signed in.

## Layers

infra · server · computer

## Audit

Same as local.

## Telemetry

Same as local.

## Tests

- Tier 3: the full contract suite against `ecs`.
- Tier 4: E1 demos against AWS.

## Reference

OpenBot `docs/deployment.md` § Platform notes (Fargate).
