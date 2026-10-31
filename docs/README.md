---
title: aobot docs
description: Start with the architecture, then pick the next ticket from the backlog.
---

# aobot docs

Start with the architecture, then pick the next ticket from the backlog.

The architecture lives in [`arc42/`](arc42/01-introduction-and-goals.md), one file per arc42 section.
These files are the only copy: `apps/docs` renders this folder as a Starlight site (`vp run docs`).

| Doc                                                                  | What it answers                                                            |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [1. Introduction and goals](arc42/01-introduction-and-goals.md)      | What aobot is, its requirements, quality goals and stakeholders            |
| [2. Architecture constraints](arc42/02-architecture-constraints.md)  | What every design has to respect                                           |
| [3. Context and scope](arc42/03-context-and-scope.md)                | Who and what aobot talks to, and over which channels                       |
| [4. Solution strategy](arc42/04-solution-strategy.md)                | The few ideas that shape everything else                                   |
| [5. Building block view](arc42/05-building-block-view.md)            | The workspaces, the features inside each app, the provider services        |
| [6. Runtime view](arc42/06-runtime-view.md)                          | One chat turn, how a turn ends early, the planned life of a tool call      |
| [7. Deployment view](arc42/07-deployment-view.md)                    | Docker Compose today, AWS later                                            |
| [8. Crosscutting concepts](arc42/08-crosscutting-concepts.md)        | Configuration, errors, persistence, guardrails, security, telemetry, tests |
| [9. Architecture decisions](arc42/09-architecture-decisions.md)      | Every decision as a short record                                           |
| [10. Quality requirements](arc42/10-quality-requirements.md)         | Quality scenarios and what proves each one                                 |
| [11. Risks and technical debt](arc42/11-risks-and-technical-debt.md) | Known gaps and the risks the plan keeps in check                           |
| [12. Glossary](arc42/12-glossary.md)                                 | The words aobot uses                                                       |
| [design.md](design.md)                                               | How the app looks: sidebar of Bots, chat bubbles, approval cards, tokens   |
| [testing.md](testing.md)                                             | The four test tiers and what each ticket must prove                        |
| [quality-gates.md](quality-gates.md)                                 | `vp run check`, the oxlint plugins and architecture rules, knip, CI        |
| [observability.md](observability.md)                                 | How traces, logs and metrics work locally and on AWS                       |
| [ticket-template.md](ticket-template.md)                             | The shape every ticket follows                                             |
| [backlog/](backlog/README.md)                                        | Epics and tickets, in build order                                          |

Every page starts with `title` and `description` front-matter; `tools/docs/front-matter.test.ts` fails
without them.

## How we work

- **Vertical slices.** Every ticket goes through every layer it needs (page, server, gateway, computer,
  database, infrastructure) and ends in a demo someone can watch. There are no "build the database
  layer" tickets.
- **Local first, cloud ready.** Everything runs with `docker compose up` on a laptop. Moving to AWS
  changes configuration, not code. See [deployment view § Local now, AWS later](arc42/07-deployment-view.md#local-now-aws-later).
- **Done means demoed.** A ticket is done when its demo passes as an end-to-end test and its tiers 1–3
  tests are green. See [testing.md](testing.md).
