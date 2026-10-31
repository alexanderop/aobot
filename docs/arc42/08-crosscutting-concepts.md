---
title: 8. Crosscutting concepts
description: Ideas that apply across every part of aobot, from configuration and errors to guardrails, security, telemetry and tests.
---

# 8. Crosscutting concepts

## Domain model

The shared nouns live in `packages/domain` as Effect Schemas, so the server and the page decode the same
shapes. Ids are branded strings (`ConversationId`, `RunId`, `MessageId`, `BotId`), so one cannot be
passed where another is expected. The words are defined in the [glossary](12-glossary.md).

## Effect conventions

- A service is a `Context.Service` with its implementation in a `Layer.effect`. Providers (`AgentRuntime`,
  later `Computers`) are swapped by providing a different layer.
- Every operation is `Effect.fn("Domain.operation")`, for example `Chat.send` and `ConversationStore.append`.
  The name becomes the span name once telemetry is exported.
- Failures are `Schema.TaggedError`s (`Stalled`, `StepLimit`, `ModelFailed`, `ConversationBusy`) and are
  matched by tag, never by `instanceof`.
- State machines are `Data.TaggedEnum`s with `$match`, not booleans: `TurnState` on the server,
  `ConversationStatus` on the page.

## Configuration

Settings come only from Effect `Config`, read in `apps/server/src/app/config.ts`. Secrets are
`Config.Redacted`, so they never print.

| Setting                  | Default         | What it does                                                     |
| ------------------------ | --------------- | ---------------------------------------------------------------- |
| `PORT`                   | `3000`          | Where the server listens                                         |
| `WEB_DIST_DIR`           | `apps/web/dist` | The built web app it serves                                      |
| `DATABASE_PATH`          | `data/aobot.db` | The SQLite file; its folder is created at boot                   |
| `MODEL_PROVIDER`         | (required)      | `anthropic`, `openai` or `openai-compat`                         |
| `MODEL_NAME`             | (required)      | The model id at that provider                                    |
| `MODEL_API_KEY`          | (required)      | Redacted                                                         |
| `MODEL_BASE_URL`         | none            | For `openai-compat`: OpenRouter, a local server, the verify mock |
| `AGENT_MAX_STEPS`        | `8`             | Model calls one turn may make                                    |
| `AGENT_STALL_TIMEOUT_MS` | `60000`         | Silence from the model that ends a turn                          |

Adding a model provider is one row in the `modelProviders` table (`features/agent/model-providers.ts`),
not a branch in every caller.

## Persistence

One SQLite file, opened by `@effect/sql-sqlite-node`. Migrations run at every boot and are safe to repeat.
Today there are two tables, `conversations` and `messages`, with messages ordered by an autoincrement
`seq`. Writes are idempotent where a retry can happen: a message id seen before is ignored. SQL stays inside
the feature's store (`ConversationStore`), so the move to Postgres touches one place per feature
([ADR-13](09-architecture-decisions.md#adr-13--sqlite-for-the-proof-of-concept)).

## Streaming and the wire format

A turn is a stream of `ChatEvent`s over Effect RPC: `RUN_STARTED`, then `TEXT_MESSAGE_START`,
`TEXT_MESSAGE_CONTENT` per delta and `TEXT_MESSAGE_END`, then `RUN_FINISHED` or `RUN_ERROR` with a
`RunErrorCode` (`stalled`, `step_limit`, `model`, `stopped`). Names and fields are AG-UI's. Decoding
rejects anything else, including AG-UI events we do not stream yet. The page folds events with a pure
function, so the same events always give the same state. [Section 6](06-runtime-view.md) shows the order.

## Concurrency

One run per conversation. The server process owns every run, so an in-memory map from conversation to
the run's stop signal is the whole rule: an entry exists exactly while a turn runs, and a restart starts
with none. A second message is refused, not queued. With a second replica this has to become a shared lock
([section 11](11-risks-and-technical-debt.md)).

## Guardrails (planned, E1 and E2)

| Concept             | Rule                                                                                                                            | Ticket                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| One door            | Every action is a gateway tool. Only the `gateway` feature may depend on `computers`; the lint graph enforces it today          | [E1-1](../backlog/E1-a-computer/E1-1-a-bot-opens-a-page-and-tells-me-its-title.md)     |
| Grants              | A Bot may only call the tools its role grants. A missing grant is refused before any rule runs                                  | [E2-1](../backlog/E2-roles-and-guardrails/E2-1-bots-from-a-file-with-granted-tools.md) |
| Rules fail closed   | A missing rule permits nothing, a crashing rule denies                                                                          | [E2-2](../backlog/E2-roles-and-guardrails/E2-2-rules-that-fail-closed.md)              |
| Audit rows          | One row per decision, allowed or refused, a second `failed` row when the computer fails, each with its initiator and `trace_id` | [E2-4](../backlog/E2-roles-and-guardrails/E2-4-an-audit-page-people-can-read.md)       |
| Redaction           | What a Bot typed is stored as `"[14 chars]"`, never the value, in audit rows, logs and spans                                    | [E2-3](../backlog/E2-roles-and-guardrails/E2-3-never-record-secrets.md)                |
| Approvals           | An approval is bound to the exact action, spent once, never repeated after a crash, and a "No" covers equivalent actions        | [E2-5](../backlog/E2-roles-and-guardrails/E2-5-ask-before-risky-actions.md)            |
| Always the person's | Credentials, security settings and payments always go to the person, whatever the rules say                                     | [E2-6](../backlog/E2-roles-and-guardrails/E2-6-some-actions-are-always-the-persons.md) |
| Untrusted content   | Pages, command output and files reach the model inside one envelope that says they carry no authority                           | [ADR-10](09-architecture-decisions.md#adr-10--outside-content-is-untrusted-data)       |

## Security

A Bot has a shell and a browser, and both reach whatever the computer's network reaches. These hold
locally as much as on AWS. All but the first are planned with the computer and the gateway.

- **The database is not on the computers.** The SQLite file lives on a volume only the server mounts, so a
  Bot's shell has no file to read or write. True today.
- **The browser refuses private and metadata addresses.** `169.254.0.0/16`, `fe80::/10`, loopback and
  private ranges are refused, so a Bot cannot browse to internal services. `COMPUTER_ALLOW_PRIVATE_HOSTS`
  exists for local fixtures and stops the server from starting in production.
- **Addresses are checked after resolving.** The computer's filter checks every address a name resolves to,
  in every spelling (IPv4-mapped IPv6, NAT64), and connects only to the address it checked.
- **Single-user mode never faces the internet.** With it on, every request is one administrator. The
  server refuses to start if its public URL resolves to a public address, and warns on a private one.
- **Computers run unprivileged.** The browser and shell run as a non-root user in a container with all
  capabilities dropped, `no-new-privileges`, and pids and memory limits. A page exploit or a fork bomb stays
  inside one person's computer.
- **The audit trail cannot be rewritten.** A trigger refuses UPDATE and DELETE on audit rows, and an action
  whose audit row cannot be written does not run.
- **Secrets are typed by the person, not the chat.** When a Bot needs a password it asks; the person types
  it into a separate field that goes straight to the computer. The audit row records that a secret was
  supplied and its length.

The AWS-specific risks (instance metadata, the Docker socket) are in [section 11](11-risks-and-technical-debt.md).

## Observability

OpenTelemetry for traces, logs and metrics: one trace per chat turn, the `trace_id` on every audit row.
Planned in [E0-2](../backlog/E0-walking-skeleton/E0-2-one-chat-turn-is-one-trace.md); today the server logs
through Effect's logger and Grafana runs in Compose with nothing sent to it. See
[observability](../observability.md).

## Testing and quality gates

Four test tiers, from pure functions to a browser demo per ticket, are in [testing](../testing.md).
`vp run check` (format, lint with our plugins, type-check, tests, knip) and the architecture rules are in
[quality gates](../quality-gates.md).

## User interface

A messenger where the coworkers happen to be Bots: dark, calm, one accent colour, approvals as cards in the
chat. The tokens and layout are in [design](../design.md).
