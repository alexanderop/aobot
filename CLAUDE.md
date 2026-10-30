# aobot

AI coworkers with their own computer and guardrails. Read `docs/README.md` first.

## Status

Quality gates are in place (`vp run check`, E0-4). No app code yet. The next ticket is `docs/backlog/E0-walking-skeleton/E0-1-chat-with-a-bot-locally.md`.

## Commands

- `vp run check`: `vp check` (format, lint with our plugins, type-check), then `vp test run` (`unit`, `architecture`), then knip. Run it before calling anything done. Works today.
- `vp install`: installs with the pinned pnpm. `vp fmt` formats. `vp check --fix` formats and autofixes.
- Imports: tests use `vite-plus/test`, lint plugins use `vite-plus/lint/plugins` (enforced by `vite-plus/prefer-vite-plus-imports`).
- `vp run test:contract` (from E1-1): computer provider contract suite. Needs Docker.
- `vp run verify <ticket-id>` (from E0-1): the ticket's demo in a real browser with `agent-browser`. A slice is done only when this passes.
- `docker compose up` (from E0-1): Postgres, the server, `grafana/otel-lgtm` (Grafana on http://localhost:3300).

## Rules

- Work in vertical slices: one ticket, every layer it needs, ending in its demo. Follow `docs/ticket-template.md`.
- Feature-based: `src/app`, `src/features/<feature>/public.ts`, `src/shared`. Register a feature in `tools/oxlint/aobot-architecture/policy.ts` before creating it.
- Every action a Bot takes goes through the gateway: only the `gateway` feature may depend on `computers`.
- Settings only through Effect `Config`. No `process.env` elsewhere.
- Never write what a Bot typed into audit rows, logs or spans. Use `redact()`.
- Effect v4 conventions: `Context.Service`, `Layer.effect`, `Effect.fn("Domain.operation")`, `Schema.TaggedError`. See the `effect` skill.
- When a ticket is done, set `status: done` in its front-matter and add its `verify` scenario in the same change.
- The UI follows `docs/design.md`.
