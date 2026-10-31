---
title: 2. Architecture constraints
description: The technical, organizational and convention constraints every design in aobot has to respect.
---

# 2. Architecture constraints

## Technical

| Constraint                                 | Why                                                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript everywhere, Effect v4 (`4.1.0`) | Typed errors, layers and `Effect.fn` spans are the backbone of the server ([ADR-3](09-architecture-decisions.md#adr-3--effect-v4-on-the-server))        |
| Node 26 in a container (`node:26-slim`)    | The image Compose runs is the image AWS runs                                                                                                            |
| React 19 with `@effect/atom-react`         | State in atoms, read through a few hooks ([ADR-12](09-architecture-decisions.md#adr-12--ag-ui-events-over-effect-rpc-read-through-atoms))               |
| Vite+ (`vp`) as the one toolchain, pnpm 11 | One config for format, lint, type-check and tests. See [quality gates](../quality-gates.md)                                                             |
| SQLite now, Postgres for the cloud         | One server process needs one file. The cloud move switches to Postgres ([ADR-13](09-architecture-decisions.md#adr-13--sqlite-for-the-proof-of-concept)) |
| No external service                        | No CopilotKit Intelligence, no hosted thread store: threads, messages and audit live in our database                                                    |
| Runs on a laptop and in our AWS account    | `docker compose up` locally; ECS, RDS and Secrets Manager later ([E5](../backlog/E5-aws/README.md))                                                     |

## Organizational

| Constraint                              | Consequence                                                                                                                                                                                                                               |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One developer, a learning project       | Prefer the simplest design that proves the idea. No second replica, no queue, no cache yet                                                                                                                                                |
| Vertical slices                         | Every ticket goes through every layer it needs and ends in a demo. See the [ticket template](../ticket-template.md)                                                                                                                       |
| Done means demoed                       | A ticket is done when `vp run verify <ticket>` passes in a real browser. See [testing](../testing.md)                                                                                                                                     |
| OpenBot is the reference implementation | Ideas are checked against `~/Projects/OpenBot` before they are reinvented. Its [`docs/architecture.md`](https://github.com/CopilotKit/openbot/blob/main/docs/architecture.md) and `charts/openbot/README.md` are the best starting points |

## Conventions

These are enforced by tooling, not by this page. `vp run check` fails when one is broken.

- **Feature-based layout.** `src/app`, `src/features/<feature>/public.ts`, `src/shared`, with the allowed
  dependencies declared in `tools/oxlint/aobot-architecture/policy.ts`.
- **Settings only through Effect `Config`.** No `process.env` outside a `config.ts`.
- **Never record what a Bot typed.** Audit rows, logs and spans get `redact()`ed values.
- **Effect v4 style.** `Context.Service`, `Layer.effect`, `Effect.fn("Domain.operation")`, `Schema.TaggedError`.
- **The UI follows** [design.md](../design.md).
