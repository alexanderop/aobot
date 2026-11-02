import { type AuditFilters, AuditQuery, isDecision } from "@aobot/domain";
import { DateTime, Option, Schema } from "effect";

/** Every row, as the page opens without filters. */
export const noFilters: AuditFilters = {
  bot: Option.none(),
  person: Option.none(),
  decision: Option.none(),
  from: Option.none(),
  to: Option.none(),
};

const decodeQuery = Schema.decodeUnknownOption(AuditQuery);

const encodeQuery = Schema.encodeSync(AuditQuery);

/** The filters `url` keeps, or none at all when its query is not one the server would read. */
export function filtersOf(url: URL): AuditFilters {
  return Option.match(decodeQuery(Object.fromEntries(url.searchParams)), {
    onNone: () => noFilters,
    onSome: ({ bot, person, decision, from, to }) => ({ bot, person, decision, from, to }),
  });
}

/** `filters` as the query of a URL, which both the page's own URL and `GET /audit/rows` read. */
export function searchOf(filters: AuditFilters): string {
  return new URLSearchParams(
    encodeQuery({ ...filters, cursor: Option.none(), limit: Option.none() }),
  ).toString();
}

/** Where the page reads the rows the filters in `search` let through, after `cursor` when there is one. */
export function rowsHref(search: string, cursor: Option.Option<string>): string {
  const query = new URLSearchParams(search);

  if (Option.isSome(cursor)) query.set("cursor", cursor.value);

  return `/audit/rows?${query.toString()}`;
}

/** `url` keeping `filters`, so a reload or a copied link shows the same rows. */
export function withFilters(url: URL, filters: AuditFilters): URL {
  const next = new URL(url);
  next.search = searchOf(filters);

  return next;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** `instant` as a `datetime-local` input shows it, in the browser's own time zone, to the minute. */
export function toLocalInput(instant: DateTime.Utc): string {
  const date = DateTime.toDateUtc(instant);

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The instant a `datetime-local` input's value names in the browser's own time zone, or none for blank. */
export function fromLocalInput(value: string): Option.Option<DateTime.Utc> {
  return value === "" ? Option.none() : DateTime.make(new Date(value));
}

/** The text of a field, or none when it is blank. */
const filled = (value: string): Option.Option<string> =>
  value.trim() === "" ? Option.none() : Option.some(value.trim());

const decodeField = Schema.decodeUnknownOption(Schema.String);

/** What the filter form's fields ask for, as they read in its `FormData`. */
export function filtersFromForm(form: FormData): AuditFilters {
  const field = (name: string) => Option.getOrElse(decodeField(form.get(name)), () => "");

  return {
    bot: filled(field("bot")),
    person: filled(field("person")),
    decision: Option.filter(filled(field("decision")), isDecision),
    from: fromLocalInput(field("from")),
    to: fromLocalInput(field("to")),
  };
}
