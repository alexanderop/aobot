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
  the web app's files, the health check, the RPC socket and a person's files. Logs written inside a span carry its
  `trace_id`.

  Taking control and handing it back are traces of their own, `ComputerControl.take` and
  `ComputerControl.handBack`, with span events for each step (`control.door_closed`, `control.taken`,
  `control.released`). A Bot call refused while a person holds the computer adds `control.refused` to its
  `Gateway.act` span.

  A Bot's `read_file` and `write_file` record the file's size on their `Gateway.act` span as
  `gateway.file_bytes`, and `list_files` the number of entries as `gateway.file_entries`. A person's
  upload and download are traces of their own, `FileTransfers.upload` and `FileTransfers.download`, with
  `gateway.action` (`file.uploaded` or `file.downloaded`) and `gateway.file_bytes`. The upload's span
  lasts until the computer saved the file; the download's until the person's request ended, after its
  last byte or not. No span holds a path or what a file holds, the HTTP client's spans of the requests
  to the computer included, which record `path=REDACTED`; the path is in the audit row.

- **Computer.** The server sends a `traceparent` header with every request, so browser actions appear
  inside the same trace.
- **Agent.** With `api`, `effect/ai` writes a span per model call with the GenAI attributes (model,
  tokens) inside `Chat.turn`, so cost per turn is in the trace. With `acp`, the CLI runs outside our
  process: we record one `AgentRuntime.turn` span around it, and token counts only if the CLI reports them.

## Audit rows link to traces

Every audit row stores the `trace_id` of the turn that caused it. A person's file transfers are audited
too: `file.uploaded` and `file.downloaded`, each an `allow` row with the file's path, name, extension and,
for an upload, its size, then an outcome row with the size, or a `deny` row with why. A transfer's rows
carry the `trace_id` of its own trace. The audit page links each row to its
trace, so "the Bot did X" leads straight to everything that happened around it.

## Where it goes

|                       | Local                                                                                    | AWS                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Collector and storage | `grafana/otel-lgtm`, one container with the collector, traces, logs, metrics and Grafana | AWS OpenTelemetry collector (ADOT) to X-Ray and CloudWatch, or Grafana Cloud |
| Switch                | `OTEL_EXPORTER_OTLP_ENDPOINT`                                                            | the same variable                                                            |

## Never in telemetry

The same rule as the audit trail: nothing a Bot typed, no secrets, no tokens. Span attributes go
through the same `redact()` as audit rows.
