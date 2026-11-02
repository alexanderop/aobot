---
id: E2-4
title: An audit page people can read
epic: E2
status: done
depends_on: [E2-2, E2-3]
estimate: 3d
---

# E2-4 · An audit page people can read

**Story:** As security, I filter every action by Bot, person and decision, and open the trace behind any row.

## Scope

In:

- Audit page with filters: Bot, person, decision, time range
- Each row links to its trace in Grafana by `trace_id`
- Paged from the database, newest first
- A database trigger refuses UPDATE and DELETE on audit rows
- One list of event types and how each reads; an unknown type shows as "Unknown", never as "Allowed"
- Paging ordered by `created_at` then `seq`, with a cursor exactly as precise as the stored `created_at`; a bad cursor is a 400

Built before E2-5, so it no longer waits for it: the server writes each row's action as an `AuditAction`
from `packages/domain/src/audit.ts`, and E2-5's approval actions will not compile until they join that
list with a label. Rows are ordered by `seq`, the order they were written in, after `created_at`, not by
`id`: ids are random UUIDs, and an allow row and its outcome often share a millisecond. The cursor carries
`created_at` exactly as the column stores it (to the millisecond), so nothing is lost between pages.

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
- Tier 2: UPDATE and DELETE on the audit table fail.
- Tier 2: rows written in the same millisecond all appear once across page boundaries.
- Tier 1: every event type has a label; an unknown one reads "Unknown".

## Reference

- OpenBot audit screen and `docs/architecture.md` § Taking the trail out.
- OpenBot #302 (refusals shown as Allowed), `server/drizzle/0000_schema.sql` (`prevent_audit_event_mutation`), `server/tests/audit-cursor.integration.test.ts`.
