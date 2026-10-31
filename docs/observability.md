# Observability

OpenTelemetry for traces, logs and metrics, from the first ticket.

## What gets traced

- **Server.** Effect exports OTLP itself (`effect/observability/Otlp`) to `OTEL_EXPORTER_OTLP_ENDPOINT`.
  Without that variable the server exports nothing, so it also runs without a collector.

  ```ts
  Otlp.layerJson({ baseUrl: otlpEndpoint, resource: { serviceName: "aobot-server" } });
  ```

  The `Chat.send` handler opens a root span, `Chat.turn`, around the whole answer stream, so one chat
  turn is one trace. Every service method written with `Effect.fn("Domain.operation")` is a span inside
  it, without extra code:

  ```text
  Chat.turn
  ├─ Chat.send                  (storing the message: ConversationStore.* and their sqlite spans)
  ├─ AgentRuntime.run
  │  └─ Chat.streamText
  │     └─ LanguageModel.streamText   (one per model call, with its HTTP POST)
  └─ ConversationStore.append   (storing the reply)
  ```

  RPC and HTTP request spans are off. RPC spans would add a second trace per call, and HTTP carries only
  the web app's files, the health check and the RPC socket. Logs written inside a span carry its
  `trace_id`.

- **Computer.** The server sends a `traceparent` header with every request, so browser actions appear
  inside the same trace.
- **Agent.** With `api`, `effect/ai` writes a span per model call with the GenAI attributes (model,
  tokens) inside `Chat.turn`, so cost per turn is in the trace. With `acp`, the CLI runs outside our
  process: we record one `AgentRuntime.turn` span around it, and token counts only if the CLI reports them.

## Audit rows link to traces

Every audit row stores the `trace_id` of the turn that caused it. The audit page links each row to its
trace, so "the Bot did X" leads straight to everything that happened around it.

## Where it goes

|                       | Local                                                                                    | AWS                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Collector and storage | `grafana/otel-lgtm`, one container with the collector, traces, logs, metrics and Grafana | AWS OpenTelemetry collector (ADOT) to X-Ray and CloudWatch, or Grafana Cloud |
| Switch                | `OTEL_EXPORTER_OTLP_ENDPOINT`                                                            | the same variable                                                            |

## Never in telemetry

The same rule as the audit trail: nothing a Bot typed, no secrets, no tokens. Span attributes go
through the same `redact()` as audit rows.
