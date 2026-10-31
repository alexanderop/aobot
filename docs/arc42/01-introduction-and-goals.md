---
title: 1. Introduction and goals
description: What aobot is, what it must do, the qualities that matter most, and who cares about them.
---

# 1. Introduction and goals

aobot is a learning project and a proof of concept: AI coworkers with their own computer and
guardrails. It is inspired by [CopilotKit OpenBot](https://github.com/CopilotKit/openbot) and rebuilt
on our own stack, so it needs no external service and can later run entirely inside our AWS account.

## What aobot is

A chatbot answers. A coworker acts: it opens pages, fills in forms, runs scripts. aobot gives each Bot
three things:

|                | What it means                                                              | Where it lives                       | Today                                                                                                                                                               |
| -------------- | -------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A role**     | A name, instructions, and the tools it is granted                          | `bots.yaml`, later the admin UI      | One hard-coded Bot, `Assistant`, with no tools. Bots from a file arrive with [E2-1](../backlog/E2-roles-and-guardrails/E2-1-bots-from-a-file-with-granted-tools.md) |
| **A computer** | Its own Chromium, bash and `/workspace`, in a container                    | `apps/computer`                      | Planned, [E1-1](../backlog/E1-a-computer/E1-1-a-bot-opens-a-page-and-tells-me-its-title.md)                                                                         |
| **Guardrails** | Grants, rules that fail closed, an audit trail, a person who can take over | The gateway feature in `apps/server` | Planned, [E1](../backlog/E1-a-computer/README.md) and [E2](../backlog/E2-roles-and-guardrails/README.md)                                                            |

## Requirements overview

The backlog is the requirements list. Each epic ends in a demo:

| Epic                                                                      | What a person can do when it is done                                                           | Status      |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------- |
| [E0 · Walking skeleton](../backlog/E0-walking-skeleton/README.md)         | Run `docker compose up`, chat with a Bot in the browser, see the turn as one trace             | in progress |
| [E1 · A computer](../backlog/E1-a-computer/README.md)                     | Watch a Bot open a page, click, type and run a command, then take the mouse and hand it back   | planned     |
| [E2 · Roles and guardrails](../backlog/E2-roles-and-guardrails/README.md) | Read every action and every refusal on an audit page, with no secrets in it                    | planned     |
| [E3 · People](../backlog/E3-people/README.md)                             | Sign in with company SSO, each with their own computer                                         | planned     |
| [E4 · Desktop app](../backlog/E4-desktop-app/README.md)                   | Install the app, get notified when a Bot needs help, let a Bot work on your Mac                | planned     |
| [E5 · AWS](../backlog/E5-aws/README.md)                                   | Use aobot in our AWS account, with one ECS task per person and no way to reach AWS credentials | planned     |

[E0-1 · Chat with a Bot locally](../backlog/E0-walking-skeleton/E0-1-chat-with-a-bot-locally.md) is
done: a person chats with one Bot, the answer streams word by word, and a reload keeps the conversation.

## Quality goals

The top five, in priority order. [Section 10](10-quality-requirements.md) turns each into scenarios.

| #   | Quality goal       | What it means for aobot                                                                                 |
| --- | ------------------ | ------------------------------------------------------------------------------------------------------- |
| 1   | **Safety**         | A Bot can only act through the gateway. Anything unclear is refused (fail closed)                       |
| 2   | **Accountability** | Every action, allowed or refused, leaves an audit row that names who asked and links to its trace       |
| 3   | **Responsiveness** | Answers stream as they arrive. A model that goes quiet is stopped and the person is told                |
| 4   | **Portability**    | Everything runs with `docker compose up`. Moving to AWS changes configuration, not code                 |
| 5   | **Simplicity**     | One developer can hold it in their head: one server process, one database file, rules enforced by tools |

## Stakeholders

| Who                                | What they expect                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------- |
| Alexander, the developer           | A project to learn Effect v4, agent loops and sandboxing on, small enough to finish           |
| Colleagues who use Bots            | A Bot that does the task, asks before risky actions, and lets them take over                  |
| Security                           | No action without a check, a trail that cannot be rewritten, no secrets in logs               |
| Whoever runs it                    | `docker compose up` locally, later a deploy into our AWS account with no external service     |
| Coding agents working on this repo | `CLAUDE.md` and these docs as the source of truth, and checks that fail when a rule is broken |
