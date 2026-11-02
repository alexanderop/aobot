import type { AuditFilters } from "@aobot/domain";
import { DateTime, Option } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  filtersFromForm,
  filtersOf,
  fromLocalInput,
  noFilters,
  rowsHref,
  searchOf,
  toLocalInput,
  withFilters,
} from "./audit-filters.ts";

const page = new URL("http://aobot.test/audit");

const everyFilter: AuditFilters = {
  bot: Option.some("researcher"),
  person: Option.some("single-user"),
  decision: Option.some("deny"),
  from: Option.some(DateTime.makeUnsafe("2026-11-02T09:00:00.000Z")),
  to: Option.some(DateTime.makeUnsafe("2026-11-02T10:00:00.000Z")),
};

/** A filter form whose fields hold `fields`, as a person filled them in. */
function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  Object.entries(fields).forEach(([name, value]) => data.set(name, value));

  return data;
}

describe("the audit page's URL", () => {
  it("keeps every filter across a reload", () => {
    const url = withFilters(page, everyFilter);

    expect(url.pathname).toBe("/audit");
    expect(filtersOf(url)).toEqual(everyFilter);
  });

  it("names no filter when none is set", () => {
    expect(withFilters(page, noFilters).search).toBe("");
    expect(filtersOf(page)).toEqual(noFilters);
  });

  it("shows every row for a query the server would refuse", () => {
    expect(filtersOf(new URL("http://aobot.test/audit?decision=approved&bot=scribe"))).toEqual(
      noFilters,
    );
  });
});

describe("rowsHref", () => {
  it("asks for the filtered rows, after the cursor when there is one", () => {
    const search = searchOf({ ...noFilters, decision: Option.some("deny") });

    expect(rowsHref(search, Option.none())).toBe("/audit/rows?decision=deny");
    expect(rowsHref(search, Option.some("eyJzZXEiOjF9"))).toBe(
      "/audit/rows?decision=deny&cursor=eyJzZXEiOjF9",
    );
  });
});

describe("the filter form", () => {
  it("reads blank fields as no filter", () => {
    expect(
      filtersFromForm(form({ bot: "", person: "  ", decision: "", from: "", to: "" })),
    ).toEqual(noFilters);
  });

  it("reads each filled field, a time as the browser's own", () => {
    expect(
      filtersFromForm(
        form({
          bot: "researcher",
          person: " single-user ",
          decision: "deny",
          from: "2026-11-02T09:00",
          to: "",
        }),
      ),
    ).toEqual({
      ...noFilters,
      bot: Option.some("researcher"),
      person: Option.some("single-user"),
      decision: Option.some("deny"),
      from: DateTime.make(new Date(2026, 10, 2, 9, 0)),
    });
  });

  it("ignores a decision it does not know", () => {
    expect(filtersFromForm(form({ decision: "approved" })).decision).toEqual(Option.none());
  });

  it("shows an instant in its time field as the minute it names", () => {
    const instant = DateTime.makeUnsafe(new Date(2026, 10, 2, 9, 5));

    expect(toLocalInput(instant)).toBe("2026-11-02T09:05");
    expect(fromLocalInput(toLocalInput(instant))).toEqual(Option.some(instant));
  });
});
