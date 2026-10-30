# E0 · Walking skeleton

The thinnest path through every layer: a person chats with a Bot, the turn is traced, and CI guards the rules. No tools yet.

**Epic demo:** A developer runs `docker compose up`, chats with a Bot in the browser, and sees the turn as one trace in Grafana.

| Ticket | Title | Depends on | Estimate |
| --- | --- | --- | --- |
| [E0-1](E0-1-chat-with-a-bot-locally.md) | Chat with a Bot locally | – | 3d |
| [E0-2](E0-2-one-chat-turn-is-one-trace.md) | One chat turn is one trace | E0-1 | 1d |
| [E0-3](E0-3-a-scripted-model-for-tests.md) | A scripted model for tests | E0-1 | 1d |
| [E0-4](E0-4-ci-that-enforces-our-rules.md) | CI that enforces our rules | E0-1 | 1d |
