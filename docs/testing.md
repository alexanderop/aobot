# Testing

Four tiers. Each tier proves something the one below cannot.

| Tier              | Proves                                     | How                                                                                                                                                                              | How many       |
| ----------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| **1. Pure**       | Grants, rules, redaction, snapshot capping | Plain unit tests, no I/O                                                                                                                                                         | Most tests     |
| **2. Services**   | Gateway, AgentRuntime, Computers logic     | `@effect/vitest` with fake layers: fake computers, in-memory audit, recorded ACP adapters. `TestClock` for anything timed                                                        | Many           |
| **3. Contract**   | Every provider behaves the same            | One suite per service: computers (`docker` now, `ecs`, `k8s` and `mac` later) against a local HTML fixture; agent runtimes (`api` and each `acp` CLI) against the scripted model | Few            |
| **4. End to end** | One ticket's demo works                    | `docker compose up`, a scripted model, and an `agent-browser` run of the demo                                                                                                    | One per ticket |

## The model in tests

Tests never depend on what a real model happens to say. A test writes what the model does as a
`ModelScript`. Tier 2 replays it through a scripted `LanguageModel` layer. Tiers 3 and 4 point `api`
and every `acp` CLI at our own mock model server, which replays the same script in the Anthropic
Messages, OpenAI Responses and OpenAI Chat Completions shapes. Both live in
`apps/server/src/features/agent/testing/`; `verify/mock-model.ts` runs the server for tier 4. See
[E0-3](backlog/E0-walking-skeleton/E0-3-a-scripted-model-for-tests.md).

## Recorded adapters

The contract suite is slow and needs the network, so tier 2 also replays what each real ACP adapter
said. `vp run test:contract:agents:record` runs the suite with `ACP_RECORD=true`: each CLI turn's
JSON-RPC messages go to `apps/server/src/features/agent/acp/fixtures/<scenario>/<agent>.ndjson`, with
the turn's folder as `<workspace>`, the gateway URL as `<gateway>` and the person's own command list
emptied. `acp-replay.test.ts` plays them back in-process (`testing/replay-spawner.ts`): the replay
writes what the adapter wrote and checks that our client writes exactly what it wrote then. No process,
no network, the test clock, about half a second for every agent and scenario.

- **Re-record** after changing a launcher (an adapter version, its flags) or anything our client sends.
  A replay names the first message that differs, and a changed launch command fails every replay.
- **Gates** hold a replay before a message by its label (`session/update`, `answer:2`) until the test
  releases it, to catch a turn at an exact point: all words streamed, prompt not yet answered, or a
  stall on the test clock.
- Real processes stay in `acp-runtime.test.ts`, with `testing/fake-acp-agent.ts`: ending the process
  group needs one.

## Determinism

Tests never wait on real time or sleeps: `it.effect` runs on the test clock, and a test waits for the
event it needs (a `Deferred`, a queue item, a replay gate). Ids come from Effect's `Random`
(`shared/random-id.ts`), so `shared/testing/deterministic.ts` can seed them alongside the test clock.
`it.live` is for tests that drive real processes or servers.

One nightly smoke test (`vp run test:smoke`, `*.smoke.ts`) runs against the real model, so a model or
SDK change shows up within a day.

## Rules the tooling enforces

See [quality-gates.md](quality-gates.md): `vp run check`, the oxlint plugins, the architecture
rules and the tests that keep the docs honest.

## Definition of done for a ticket

1. Tiers 1–3 cover the new logic and are green in CI.
2. The ticket's **Demo** section runs as a tier-4 test and passes.
3. The ticket's **Audit** and **Telemetry** expectations are asserted, not just eyeballed.
