# aobot

AI coworkers with their own computer and guardrails. Read `docs/README.md` first.

## Status

E0-1 to E0-5 and E1-1 to E1-3 are done: chat with one Bot over `docker compose up`, or on the host on your own Claude Code or Codex subscription over ACP with their own tools switched off (OpenCode passes the contract suite, not yet the demo); the Bot browses on its own computer, reads pages as text with a ref per element, clicks and types by those refs, and runs bash commands in its own `/workspace` with only PATH, locale and the egress filter in their environment, each action through the gateway with an audit row; each chat turn is one `Chat.turn` trace in Grafana, every test runs on a scripted model, and `vp run check` fails CI when a change breaks one of our rules, proven by `vp run verify E0-1` to `E1-3`. The next ticket is `docs/backlog/E1-a-computer/E1-4-watch-the-live-screen.md`.

## Commands

- `vp run check`: `vp check` (format, lint with our plugins, type-check), then `vp test run` (`unit`, `architecture`), then knip. Run it before calling anything done. Works today.
- `vp install`: installs with the pinned pnpm. `vp fmt` formats. `vp check --fix` formats and autofixes.
- Imports: tests use `vite-plus/test`, lint plugins use `vite-plus/lint/plugins` (enforced by `vite-plus/prefer-vite-plus-imports`).
- `vp run test:smoke` (from E0-3): one turn against the real model in `MODEL_*`. Not part of `check`; runs nightly.
- `vp run test:contract:agents` (from E0-5): agent runtime contract suite (`*.contract.ts`): `api` and each `acp` CLI against the mock model server, streaming, cancel, and no shell or file access outside the gateway. Starts the real pinned adapters through `npx`. Not part of `check`.
- `vp run test:contract` (from E1-1): computer provider contract suite. Builds `aobot-computer:dev` from `apps/computer/Dockerfile` and runs it against a local fixture. Needs Docker. Not part of `check`; CI runs it.
- The computer image (from E1-1): `docker compose up --build` builds `aobot-computer:dev` through its `computer-image` service. A server on the host needs it built by hand: `docker build -f apps/computer/Dockerfile -t aobot-computer:dev .` from the root.
- `vp run dev:acp` (from E0-5): builds the web app and serves it on http://localhost:3100 on your own Claude Code subscription over `acp`, with the CLI signed in as usual. The Bot's computer needs the image above. `ACP_AGENT=codex vp run dev:acp` for Codex, `PORT=…` to move it. `acp` refuses to start without single-user mode on loopback, so it never runs in compose.
- `vp run verify <ticket-id>` (from E0-1): the ticket's demo in a real browser with `agent-browser`. A slice is done only when this passes. Its stack publishes the server on 3100 and Grafana on 3400, so it runs beside `docker compose up`. A scenario that exports `stack = false` runs without the stack.
- `docker compose up` (from E0-1): the server (SQLite file on a volume only it mounts), `grafana/otel-lgtm` (Grafana on http://localhost:3300, traces under Explore → Tempo from E0-2). From E1-1 the server mounts the Docker socket and starts the computer (`aobot-computer`) itself, on the `aobot_computers` network it shares only with the server and the collector.

## Rules

- Work in vertical slices: one ticket, every layer it needs, ending in its demo. Follow `docs/ticket-template.md`.
- Feature-based: `src/app`, `src/features/<feature>/public.ts`, `src/shared`. Register a feature in `tools/oxlint/aobot-architecture/policy.ts` before creating it.
- Every action a Bot takes goes through the gateway: only the `gateway` feature may depend on `computers`.
- Settings only through Effect `Config`. No `process.env` elsewhere.
- Never write what a Bot typed into audit rows, logs or spans. Use `redact()`.
- Effect v4 conventions: `Context.Service`, `Layer.effect`, `Effect.fn("Domain.operation")`, `Schema.TaggedError`. See the `effect` skill.
- When a ticket is done, set `status: done` in its front-matter and add its `verify` scenario in the same change.
- The UI follows `docs/design.md`.
- Every PR description follows the `pr` skill (`.claude/skills/pr/SKILL.md`): Summary, Evidence, Merge Danger.
- The web app is React with `@effect/atom-react`: state in atoms, read through a few hooks. See `docs/architecture.md` § The web app.

## Reference repositories

Source-of-truth code for libraries this project depends on, checked out outside the repository. Treat as **read-only reference material**. When asked about a library listed below, explore its source there first instead of guessing or relying on training data. Claude Code reaches these through `permissions.additionalDirectories`; other agents need the equivalent grant.

- `~/Projects/OpenBot`: the reference implementation of every idea in `docs/`.
- `~/Projects/opensource/CopilotKit`: shape reference only (we build our own hooks on Effect atoms, never import it): https://github.com/CopilotKit/CopilotKit @ `pinned/1.83.0` (the version OpenBot uses). Frontend hooks in `packages/react-core/src/v2/hooks/` (`use-agent.tsx`, `use-render-tool-call.tsx`, `use-human-in-the-loop.tsx`, `use-interrupt.tsx`). Its wire format is AG-UI, `@ag-ui/core` 1.0.2.
- `~/Projects/opensource/effect`: Effect v4, including `effect/ai` (`ai-docs/src/71_ai/`), atoms in
  `packages/effect/src/reactivity/` (`Atom.ts`, `AtomRpc.ts`) and the React bindings in `packages/atom/react/`.
- `~/Projects/opensource/t3code`: an ACP client in Effect (`packages/effect-acp/`, `packages/provider-acp/`).
