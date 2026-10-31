---
title: Backlog
description: Epics in build order. Each epic ends in a demo; each ticket is a vertical slice with its own demo. Ticket files follow the template; their front-matter (id, status, depends_on) is meant to be turned into GitHub issues later.
---

# Backlog

Epics in build order. Each epic ends in a demo; each ticket is a vertical slice with its own demo.
Ticket files follow [the template](../ticket-template.md); their front-matter (`id`, `status`,
`depends_on`) is meant to be turned into GitHub issues later.

| Epic                                                           | Demo when it is done                                                                                                                                     | Tickets | Estimate |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------- |
| [E0 · Walking skeleton](E0-walking-skeleton/README.md)         | A developer runs `docker compose up`, chats with a Bot in the browser, and sees the turn as one trace in Grafana.                                        | 5       | 11d      |
| [E1 · A computer](E1-a-computer/README.md)                     | You watch a Bot open a page, click, type and run a command, then take the mouse yourself and hand it back.                                               | 6       | 14d      |
| [E2 · Roles and guardrails](E2-roles-and-guardrails/README.md) | Security opens the audit page and sees every action, every refusal and its rule, with a link to the trace, and no secrets.                               | 7       | 18d      |
| [E3 · People](E3-people/README.md)                             | Two colleagues sign in with company SSO, each with their own computer and logins, and idle computers stop by themselves.                                 | 4       | 12d      |
| [E4 · Desktop app](E4-desktop-app/README.md)                   | A colleague installs the app, signs in once, gets a notification when their Bot needs help, and lets the Bot work on their Mac too.                      | 4       | 12d      |
| [E5 · AWS](E5-aws/README.md)                                   | The desktop app talks to aobot in AWS, Bots run on the chosen model provider, each person's computer is an ECS task, and none can reach AWS credentials. | 4       | 16d      |

Estimates are one developer's working days, before review. E5-4 is optional.

## Order

E0 → E1 → E2 → E3. Once E3-1 is done, E4 and E5 can run in parallel with the rest of E3.

Inside an epic, follow `depends_on`. A ticket can start when everything it depends on is `done`.

## Later

Ideas with no tickets yet: [later.md](later.md).
