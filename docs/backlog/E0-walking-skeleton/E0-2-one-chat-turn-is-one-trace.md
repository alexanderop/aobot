---
id: E0-2
title: One chat turn is one trace
description: As a developer, I open Grafana and see one trace per chat turn, so I can tell where time went.
epic: E0
status: todo
depends_on: [E0-1]
estimate: 1d
---

# E0-2 · One chat turn is one trace

**Story:** As a developer, I open Grafana and see one trace per chat turn, so I can tell where time went.

## Scope

In:

- `grafana/otel-lgtm` container in Compose
- `Otlp.layer` in the server, endpoint from `OTEL_EXPORTER_OTLP_ENDPOINT`
- Every service method uses `Effect.fn("Domain.operation")`
- Logs carry the `trace_id`

Out:

- Computer spans (E1-1)
- AWS collector (E5-1)

## Demo

1. Send a message.
2. Open Grafana at `http://localhost:3300`, Explore → Tempo.
3. The newest trace is named `Chat.turn` and holds the agent call as a child span.

## Layers

server · infra

## Audit

None.

## Telemetry

`Chat.turn` with a child span for the model call.

## Tests

- Tier 2: a turn run with an in-memory tracer produces `Chat.turn` with the expected children.
- Tier 4: the demo, asserting the trace exists through the Tempo API.

## Reference

See [observability.md](../../observability.md).
