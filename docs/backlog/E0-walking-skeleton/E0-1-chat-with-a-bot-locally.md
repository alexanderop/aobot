---
id: E0-1
title: Chat with a Bot locally
epic: E0
status: done
depends_on: []
estimate: 4d
---

# E0-1 · Chat with a Bot locally

**Story:** As a developer, I run `docker compose up`, send a message in the browser, and a Bot answers word by word.

## Scope

In:

- pnpm workspace through Vite+: `apps/server`, `apps/web`, `packages/domain`
- Docker Compose with Postgres
- Effect server on Node (`HttpRouter`, `@effect/platform-node`), settings through `Config`
- The `AgentRuntime` service and its `api` provider: `effect/ai` `LanguageModel` with our own loop over
  `Chat`, a step cap, and the model provider (`anthropic`, `openai`, `openai-compat`) picked by `Config`
- One hard-coded Bot with an empty `Toolkit`
- Answer streamed as `ChatEvent`s defined with Effect Schema in `packages/domain`, using AG-UI's event names and
  fields (`RUN_STARTED`, `TEXT_MESSAGE_CONTENT`, `RUN_FINISHED`, `RUN_ERROR`), over a streaming Effect RPC (`Chat.send`, `Chat.stop`)
- `apps/web` in React with `@effect/atom-react`: an `AtomRpc` client, a conversation atom per id, and the
  `useConversation(id)` hook ([architecture.md § The web app](../../architecture.md#the-web-app))
- Messages stored in Postgres, so a reload keeps the conversation
- The conversation view and composer from [design.md](../../design.md): tokens, bubbles, Bot name pill
- A stall watchdog: no event from the model or CLI for `AGENT_STALL_TIMEOUT_MS` (60 s) cancels the turn and tells the person; the clock pauses while the reader is slow
- One run per conversation: a Postgres lease (120 s, renewed by a heartbeat, released in `finally`). A second message while a turn runs is refused, not queued
- At boot, one request to the provider checks the key can use the configured model and logs how to fix it; it never stops start-up

Out:

- Tools and computers (E1)
- Your own subscription over ACP (E0-5)
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

- Tier 1: `ChatEvent` decoding rejects unknown event types; each event round-trips against an AG-UI `@ag-ui/core` 1.0.2 example.
- Tier 2: the conversation atom folds a scripted event stream into messages and `isRunning`, and `stop` ends it.
- Tier 2: `AgentRuntime` (`api`) with a scripted `LanguageModel` layer emits text, then done, in order.
- Tier 2: a model that keeps calling tools stops at the step cap with a clear error.
- Tier 4: the demo.
- Tier 2: a model that goes silent is cancelled after the stall limit (`TestClock`); a slow reader is not blamed.
- Tier 2: a second turn in the same conversation is refused while the first runs; a crashed run's lease expires.

## Reference

- `effect/ai`: `~/Projects/opensource/effect/ai-docs/src/71_ai/` (`20_tools.ts`, `30_chat.ts` for the loop).
  `LanguageModel.generateText` resolves one round of tool calls; the loop is ours.
- Check the HTTP server's request and idle timeouts: an agent turn can be quiet for minutes, and a streaming
  response must not be cut off. (In the Bun prototype this was a 10-second default.)
- OpenBot `server/src/channels/stall-guard.ts`, `turn-watchdog.ts`, `toolkit/src/copilotkit/thread-lock.ts`, `server/src/model-availability-check.ts`.
