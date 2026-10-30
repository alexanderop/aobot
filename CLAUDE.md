# aobot

AI coworkers with their own computer and guardrails. Read `docs/README.md` first.

## Status

Planning only. No code yet. The next ticket is `docs/backlog/E0-walking-skeleton/E0-1-chat-with-a-bot-locally.md`.

## Commands (once E0 lands)

- `bun run check`: typecheck, oxlint with our plugins, Vitest (`unit`, `services`, `architecture`), knip. Run it before calling anything done.
- `bun run test:contract`: computer provider contract suite. Needs Docker.
- `bun run verify <ticket-id>`: the ticket's demo in a real browser with `agent-browser`. A slice is done only when this passes.
- `docker compose up`: Postgres, the server, `grafana/otel-lgtm` (Grafana on http://localhost:3300).

## Rules

- Work in vertical slices: one ticket, every layer it needs, ending in its demo. Follow `docs/ticket-template.md`.
- Every action a Bot takes goes through the gateway. Only `apps/server/src/gateway/` imports the computer client.
- Settings only through Effect `Config`. No `process.env` elsewhere.
- Never write what a Bot typed into audit rows, logs or spans. Use `redact()`.
- Effect v4 conventions: `Context.Service`, `Layer.effect`, `Effect.fn("Domain.operation")`, `Schema.TaggedError`. See the `effect` skill.
- When a ticket is done, set `status: done` in its front-matter and add its `verify` scenario in the same change.
- The UI follows `docs/design.md`.
