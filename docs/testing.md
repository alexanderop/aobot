# Testing

Four tiers. Each tier proves something the one below cannot.

| Tier              | Proves                                     | How                                                                                                                                                                              | How many       |
| ----------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| **1. Pure**       | Grants, rules, redaction, snapshot capping | Plain unit tests, no I/O                                                                                                                                                         | Most tests     |
| **2. Services**   | Gateway, AgentRuntime, Computers logic     | `@effect/vitest` with fake layers: fake computers, in-memory audit. `TestClock` for anything timed                                                                               | Many           |
| **3. Contract**   | Every provider behaves the same            | One suite per service: computers (`docker` now, `ecs`, `k8s` and `mac` later) against a local HTML fixture; agent runtimes (`api` and each `acp` CLI) against the scripted model | Few            |
| **4. End to end** | One ticket's demo works                    | `docker compose up`, a scripted model, and an `agent-browser` run of the demo                                                                                                    | One per ticket |

## The model in tests

Tests never depend on what a real model happens to say. Tier 2 provides a scripted `LanguageModel`
layer. Tiers 3 and 4 point `api` and every `acp` CLI at a mock model server that replays the same
scripts in the Anthropic and OpenAI API shapes. See [E0-3](backlog/E0-walking-skeleton/E0-3-a-scripted-model-for-tests.md).

One nightly smoke test runs against the real model, so a model or SDK change shows up within a day.

## Rules the tooling enforces

See [quality-gates.md](quality-gates.md): `vp run check`, the oxlint plugins, the architecture
rules and the tests that keep the docs honest.

## Definition of done for a ticket

1. Tiers 1–3 cover the new logic and are green in CI.
2. The ticket's **Demo** section runs as a tier-4 test and passes.
3. The ticket's **Audit** and **Telemetry** expectations are asserted, not just eyeballed.
