# aobot docs

Start with the architecture, then pick the next ticket from the backlog.

| Doc | What it answers |
| --- | --- |
| [architecture.md](architecture.md) | What aobot is, the five parts, how one request flows, and the decisions behind it |
| [testing.md](testing.md) | The four test tiers and what each ticket must prove |
| [observability.md](observability.md) | How traces, logs and metrics work locally and on AWS |
| [ticket-template.md](ticket-template.md) | The shape every ticket follows |
| [backlog/](backlog/README.md) | Epics and tickets, in build order |

## How we work

- **Vertical slices.** Every ticket goes through every layer it needs (page, server, gateway, computer,
  database, infrastructure) and ends in a demo someone can watch. There are no "build the database
  layer" tickets.
- **Local first, cloud ready.** Everything runs with `docker compose up` on a laptop. Moving to AWS
  changes configuration, not code. See [architecture.md § Local now, AWS later](architecture.md#local-now-aws-later).
- **Done means demoed.** A ticket is done when its demo passes as an end-to-end test and its tiers 1–3
  tests are green. See [testing.md](testing.md).
