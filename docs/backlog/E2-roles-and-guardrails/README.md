# E2 · Roles and guardrails

Bots become configuration with granted tools. Rules fail closed, secrets never reach the audit trail, and the trail is readable.

**Epic demo:** Security opens the audit page and sees every action, every refusal and its rule, with a link to the trace, and no secrets.

| Ticket                                              | Title                                | Depends on       | Estimate |
| --------------------------------------------------- | ------------------------------------ | ---------------- | -------- |
| [E2-1](E2-1-bots-from-a-file-with-granted-tools.md) | Bots from a file, with granted tools | E1-3             | 2d       |
| [E2-2](E2-2-rules-that-fail-closed.md)              | Rules that fail closed               | E2-1             | 3d       |
| [E2-3](E2-3-never-record-secrets.md)                | Never record secrets                 | E1-2             | 1d       |
| [E2-5](E2-5-ask-before-risky-actions.md)            | Ask before risky actions             | E2-2             | 2d       |
| [E2-4](E2-4-an-audit-page-people-can-read.md)       | An audit page people can read        | E2-2, E2-3, E2-5 | 2d       |
