---
id: E0-1
title: Chat with a Bot locally
epic: E0
status: todo
depends_on: []
estimate: 3d
---

# E0-1 · Chat with a Bot locally

**Story:** As a developer, I run `docker compose up`, send a message in the browser, and a Bot answers word by word.

## Scope

In:

- pnpm workspace through Vite+: `apps/server`, `apps/web`, `packages/domain`
- Docker Compose with Postgres
- Effect server on Node (`HttpRouter`, `@effect/platform-node`), settings through `Config`
- One hard-coded Bot running on the Claude Agent SDK with `tools: []` and `settingSources: []`
- Answer streamed as `ChatEvent`s defined with Effect Schema in `packages/domain`
- Messages stored in Postgres, so a reload keeps the conversation
- The conversation view and composer from [design.md](../../design.md): tokens, bubbles, Bot name pill

Out:

- Tools and computers (E1)
- Sign-in (E3)
- More than one Bot (E2-1)

## Demo

1. Run `docker compose up`.
2. Open `http://localhost:3000` and send "Say hi in five words".
3. The answer appears word by word.
4. Reload the page. The conversation is still there.

## Layers

web · server · database · infra

## Audit

None yet.

## Telemetry

None yet (E0-2).

## Tests

- Tier 1: `ChatEvent` decoding rejects unknown event types.
- Tier 2: `AgentRunner` with a scripted model emits text, then done, in order.
- Tier 4: the demo.

## Reference

Check the HTTP server's request and idle timeouts: an agent turn can be quiet for minutes, and a streaming response must not be cut off. (In the Bun prototype this was a 10-second default.)
