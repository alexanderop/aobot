---
title: 9. Architecture decisions
description: Every architecture decision as a short record, with its context, the choice, and what it costs.
---

# 9. Architecture decisions

Each record says why, what was decided, and what follows from it. A decision is replaced by a new record,
never edited away.

| #                                                              | Decision                                         | Status   |
| -------------------------------------------------------------- | ------------------------------------------------ | -------- |
| [1](#adr-1--no-copilotkit-intelligence)                        | No CopilotKit Intelligence                       | accepted |
| [2](#adr-2--the-think-act-loop-is-a-provider)                  | The think-act loop is a provider                 | accepted |
| [3](#adr-3--effect-v4-on-the-server)                           | Effect v4 on the server                          | accepted |
| [4](#adr-4--web-first-electron-as-a-wrapper)                   | Web first, Electron as a wrapper                 | accepted |
| [5](#adr-5--the-page-as-text-not-screenshots)                  | The page as text, not screenshots                | accepted |
| [6](#adr-6--a-computer-is-only-ever-a-url-and-a-token)         | A computer is only ever a URL and a token        | accepted |
| [7](#adr-7--fail-closed)                                       | Fail closed                                      | accepted |
| [8](#adr-8--never-log-what-a-bot-typed)                        | Never log what a Bot typed                       | accepted |
| [9](#adr-9--opentelemetry-from-day-one)                        | OpenTelemetry from day one                       | accepted |
| [10](#adr-10--outside-content-is-untrusted-data)               | Outside content is untrusted data                | accepted |
| [11](#adr-11--every-audit-row-names-its-initiator)             | Every audit row names its initiator              | accepted |
| [12](#adr-12--ag-ui-events-over-effect-rpc-read-through-atoms) | AG-UI events over Effect RPC, read through atoms | accepted |
| [13](#adr-13--sqlite-for-the-proof-of-concept)                 | SQLite for the proof of concept                  | accepted |
| [14](#adr-14--arc42-in-docs-rendered-by-starlight)             | arc42 in `docs/`, rendered by Starlight          | accepted |

### ADR-1 · No CopilotKit Intelligence

- **Context.** OpenBot keeps threads, messages and audit in CopilotKit Intelligence, a hosted service.
- **Decision.** Threads, messages and audit live in our own database.
- **Consequences.** No external licence and no data outside our account. We build the thread store and the
  audit trail ourselves.

### ADR-2 · The think-act loop is a provider

- **Context.** In the cloud any model with an API key should work; on a laptop a person wants to use their
  own Claude Code, Codex or OpenCode subscription. In both, the gateway must be the only way to act.
- **Decision.** One `AgentRuntime` service with two implementations: `api` (our own loop on `effect/ai`)
  and `acp` (the person's CLI over ACP, with only gateway tools offered). Not the Claude Agent SDK: its
  built-in tools run inside the server, beside the database file.
- **Consequences.** The rest of the server does not know which loop runs. `acp` needs a contract suite that
  proves a CLI cannot act outside the gateway. Only `api` exists today; `acp` is
  [E0-5](../backlog/E0-walking-skeleton/E0-5-chat-on-my-own-subscription.md).

### ADR-3 · Effect v4 on the server

- **Context.** Every gateway path (refused, failed, allowed) has to be visible and testable. Providers
  have to be swappable. Tracing has to come without extra code.
- **Decision.** Effect v4 for the server and the shared schemas.
- **Consequences.** Typed errors make every path visible to the compiler, layers make providers
  swappable, `Effect.fn` gives a span per operation. The cost is a steep learning curve, which is part of
  the point of this project.

### ADR-4 · Web first, Electron as a wrapper

- **Context.** The agents run on the server, not on the person's machine.
- **Decision.** Build the web app first. The desktop app wraps it and adds safe token storage and
  notifications, not core logic.
- **Consequences.** One UI codebase. The Mac as a second computer still needs the desktop app
  ([E4](../backlog/E4-desktop-app/README.md)).

### ADR-5 · The page as text, not screenshots

- **Context.** A Bot has to read pages cheaply and refer to elements precisely.
- **Decision.** `ariaSnapshot({ mode: "ai" })` with a ref per element. Snapshots are capped at 12,000
  characters.
- **Consequences.** No vision model needed and clicks address refs, not coordinates. Pages that are mostly
  canvas or images read poorly.

### ADR-6 · A computer is only ever a URL and a token

- **Context.** Where a computer runs (a laptop container, ECS, Kubernetes, a Mac) should be free to change.
- **Decision.** The server reaches a computer only through a URL and a token, never `docker exec` or shared
  files. A Mac is reached through a connection the desktop app opens, because a laptop is behind NAT.
- **Consequences.** Providers are interchangeable and pass one contract suite. The computer needs its own
  small HTTP API.

### ADR-7 · Fail closed

- **Context.** A Bot with a shell can do damage, and a policy bug must not turn into permission.
- **Decision.** A missing rule permits nothing, a crashing rule denies, a missing grant is refused before
  any rule runs.
- **Consequences.** New tools do nothing until someone grants them. Some refusals will surprise people;
  the audit page shows which rule refused.

### ADR-8 · Never log what a Bot typed

- **Context.** What a Bot types may be a password.
- **Decision.** The audit row keeps `"[14 chars]"`, not the value. Logs and spans use `redact()` too.
- **Consequences.** The trail proves that something was typed and how long it was, never what.

### ADR-9 · OpenTelemetry from day one

- **Context.** An agent turn crosses the page, the server, the model and a computer.
- **Decision.** One trace per chat turn, with the `trace_id` stored on every audit row.
- **Consequences.** An audit row links to exactly what happened. Grafana runs in Compose already; export
  arrives with [E0-2](../backlog/E0-walking-skeleton/E0-2-one-chat-turn-is-one-trace.md).

### ADR-10 · Outside content is untrusted data

- **Context.** A page can say "ignore your instructions".
- **Decision.** Pages, command output and files reach the model inside one envelope that says they carry no
  authority. A closing tag inside the content is neutralised.
- **Consequences.** The envelope tells the model that the page is not its person speaking. It lowers the
  risk of prompt injection; it does not remove it, so the guardrails still decide.

### ADR-11 · Every audit row names its initiator

- **Context.** `actor.id` says on whose authority an action ran, not whether anybody was watching.
- **Decision.** `initiator_kind` is `person` or `deployment` now, `routine` and `handoff` later.
- **Consequences.** Security can tell a person's click from a Bot acting alone.

### ADR-12 · AG-UI events over Effect RPC, read through atoms

- **Context.** We want CopilotKit's ergonomics without its runtime or a dependency on it.
- **Decision.** One `ChatEvent` Schema in `packages/domain` with AG-UI's event names and fields, streamed by
  an Effect RPC and decoded on both sides. The web reads it through `effect/reactivity` atoms in a few
  hooks shaped like CopilotKit's.
- **Consequences.** No CopilotKit dependency, and an AG-UI client could still connect through a thin
  adapter. We write the hooks ourselves.

### ADR-13 · SQLite for the proof of concept

- **Context.** aobot is a learning project with one server process. A database container is one more thing
  to run and reset.
- **Decision.** One SQLite file on a Compose volume (`DATABASE_PATH`). Postgres is the cloud target.
- **Consequences.** Nothing to operate locally. The cloud move switches to Postgres
  ([E5-1](../backlog/E5-aws/E5-1-aobot-in-our-aws-account.md)) and the in-memory run guard becomes a shared
  lock. SQL stays inside the feature stores so the switch stays in one place.

### ADR-14 · arc42 in `docs/`, rendered by Starlight

- **Context.** Agents and the backlog test read the markdown in `docs/`. People want a site to browse.
  Two copies of the same prose drift.
- **Decision.** The architecture follows arc42 in `docs/arc42/`. `apps/docs` is an Astro Starlight site
  whose content collection loads `docs/` in place with a `glob` loader, rewrites relative `.md` links to
  site routes, and draws Mermaid diagrams with `astro-mermaid`.
- **Consequences.** One source. Every page needs `title` and `description` front-matter, which a test in
  `tools/docs` checks. The site build is not part of `vp run check` yet.
