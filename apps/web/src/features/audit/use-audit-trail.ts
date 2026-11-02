import type { AuditFilters } from "@aobot/domain";
import { useAtom, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { useCallback } from "react";
import { searchOf } from "./audit-filters.ts";
import { filters as filtersAtom, trail, type TrailView, trailView } from "./audit-trail.ts";

/** The trail the audit page shows, the filters it shows it for, and what a person can do with them. */
export interface UseAuditTrail extends TrailView {
  readonly filters: AuditFilters;
  /**
  Shows the rows `next` lets through, from the newest, with a history entry. For the filters shown, it
  reads the trail again instead.
  */
  readonly filter: (next: AuditFilters) => void;
  /** Reads the page of older rows after the last one shown. */
  readonly loadMore: () => void;
  /** Reads the trail again from the newest row, as after a page that did not arrive. */
  readonly reload: () => void;
}

/** The audit trail as the page's URL filters it, read a page at a time. */
export function useAuditTrail(): UseAuditTrail {
  const [filters, setFilters] = useAtom(filtersAtom);
  const search = searchOf(filters);
  const pages = trail(search);
  const pull = useAtomSet(pages);
  const reload = useAtomRefresh(pages);

  return {
    ...trailView(useAtomValue(pages)),
    filters,
    filter: useCallback(
      (next: AuditFilters) => (searchOf(next) === search ? reload() : setFilters(next)),
      [search, reload, setFilters],
    ),
    loadMore: useCallback(() => pull(), [pull]),
    reload,
  };
}
