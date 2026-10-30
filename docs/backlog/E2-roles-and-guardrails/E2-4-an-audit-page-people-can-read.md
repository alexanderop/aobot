---
id: E2-4
title: An audit page people can read
epic: E2
status: todo
depends_on: [E2-2, E2-3, E2-5]
estimate: 2d
---

# E2-4 · An audit page people can read

**Story:** As security, I filter every action by Bot, person and decision, and open the trace behind any row.

## Scope

In:

- Audit page with filters: Bot, person, decision, time range
- Each row links to its trace in Grafana by `trace_id`
- Paged from the database, newest first

Out:

- CSV export, retention (later)

## Demo

1. Run the E2-1 and E2-2 demos.
2. Open the audit page and filter on `deny`.
3. Both refusals show with their rules; each links to its trace.

## Layers

web · server · database

## Audit

None new.

## Telemetry

None new.

## Tests

- Tier 2: the audit query with filters.
- Tier 4: the demo.

## Reference

OpenBot audit screen and `docs/architecture.md` § Taking the trail out.
