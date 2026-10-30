# Observability

OpenTelemetry for traces, logs and metrics, from the first ticket.

## What gets traced

- **Server.** Effect exports OTLP itself (`effect/observability/Otlp`). Every service method written
  with `Effect.fn("Domain.operation")` becomes a span, so a chat turn is one trace with a span per tool
  call without extra code.

  ```ts
  Otlp.layer({ baseUrl: otelUrl, resource: { serviceName: "aobot-server" } })
  ```

- **Computer.** The server sends a `traceparent` header with every request, so browser actions appear
  inside the same trace.
- **Agent.** Claude Code, which the Agent SDK runs, can export its own OpenTelemetry metrics and events
  (`CLAUDE_CODE_ENABLE_TELEMETRY=1`). Confirm the current variables in the Claude Code docs before
  relying on them.

## Audit rows link to traces

Every audit row stores the `trace_id` of the turn that caused it. The audit page links each row to its
trace, so "the Bot did X" leads straight to everything that happened around it.

## Where it goes

| | Local | AWS |
| --- | --- | --- |
| Collector and storage | `grafana/otel-lgtm`, one container with the collector, traces, logs, metrics and Grafana | AWS OpenTelemetry collector (ADOT) to X-Ray and CloudWatch, or Grafana Cloud |
| Switch | `OTEL_EXPORTER_OTLP_ENDPOINT` | the same variable |

## Never in telemetry

The same rule as the audit trail: nothing a Bot typed, no secrets, no tokens. Span attributes go
through the same `redact()` as audit rows.
