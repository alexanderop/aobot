# aobot

AI coworkers with their own computer and guardrails. Each Bot has a role, will get its own computer (a
browser, a shell and a folder), and acts only through a gateway that checks and records every action
before it happens. aobot is a learning project and a proof of concept, inspired by
[CopilotKit OpenBot](https://github.com/CopilotKit/openbot) and rebuilt on Effect v4 so it needs no
external service. Today you can chat with one Bot in the browser; computers and guardrails are next.

## Quick start

```sh
cp .env.example .env   # set MODEL_PROVIDER, MODEL_NAME and MODEL_API_KEY
docker compose up
```

Open http://localhost:3000 and send a message. Conversations are stored in one SQLite file on a Compose
volume, so they survive a restart.

## Commands

| Command              | What it does                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `vp install`         | Installs dependencies with the pinned pnpm                                                                  |
| `vp run check`       | Format, lint with our plugins, type-check, tests and knip. Run it before calling anything done              |
| `vp run verify E0-1` | Replays the ticket's demo in a real browser against a scripted mock model. Needs Docker and `agent-browser` |
| `vp run docs`        | The docs site on http://localhost:4321                                                                      |

## Layout

```
apps/
  server/        Effect on Node: chat RPCs, the agent runtime, SQLite
  web/           React + @effect/atom-react: the chat page
  docs/          Astro Starlight site that renders docs/
packages/
  domain/        Schemas shared by server and web: ChatEvent, ChatRpcs, ids
verify/          Tier 4: Compose with a mock model, one browser scenario per ticket
docs/
  arc42/         The architecture, one file per arc42 section
  backlog/       Epics and tickets, in build order
tools/oxlint/    Our lint plugins, including the architecture boundaries
```

## Architecture

The architecture is documented with arc42 in [`docs/arc42/`](docs/arc42/01-introduction-and-goals.md).
Start there, or with [`docs/README.md`](docs/README.md) for the full map.
