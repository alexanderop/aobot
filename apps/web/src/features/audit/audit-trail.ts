import { type AuditFilters, type AuditRow, AuditRowsPage } from "@aobot/domain";
import { Array, Effect, Option, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { AsyncResult, Atom } from "effect/reactivity";
import { type History, pageHistory } from "../../shared/page-history.ts";
import { filtersOf, rowsHref, withFilters } from "./audit-filters.ts";

/** The server did not answer a page of the trail, with what the person reads of why. */
export class TrailUnreadable extends Schema.TaggedError<TrailUnreadable>()("TrailUnreadable", {
  message: Schema.String,
}) {}

const decodePage = HttpClientResponse.schemaBodyJson(AuditRowsPage);

const decodeProblem = HttpClientResponse.schemaBodyJson(Schema.Struct({ message: Schema.String }));

/** The page of rows the filters in `search` let through after `cursor`, or why there is none. */
function pageOf(search: string, cursor: Option.Option<string>) {
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(rowsHref(search, cursor));

    if (response.status === 200) return yield* decodePage(response);

    const { message } = yield* decodeProblem(response).pipe(
      Effect.orElseSucceed(() => ({
        message: `The server answered ${response.status} for the audit trail.`,
      })),
    );

    return yield* new TrailUnreadable({ message });
  }).pipe(
    Effect.catchTags({
      HttpClientError: () =>
        Effect.fail(new TrailUnreadable({ message: "The audit trail did not reach the page." })),
      SchemaError: () =>
        Effect.fail(
          new TrailUnreadable({ message: "The server sent a page this page cannot read." }),
        ),
    }),
  );
}

/** What the audit page shows of the trail it has read so far. */
export interface TrailView {
  /** Every row read so far, newest first. */
  readonly rows: ReadonlyArray<AuditRow>;
  /** Whether a page is on its way: the first, or the one Load more asked for. */
  readonly loading: boolean;
  /** Whether older rows are left to load. */
  readonly more: boolean;
  /** Why the last page did not arrive. The rows read before it stay. */
  readonly problem: Option.Option<string>;
}

/** The {@link TrailView} of the pages read so far. */
export function trailView(result: Atom.PullResult<AuditRowsPage, TrailUnreadable>): TrailView {
  const pages = Option.match(AsyncResult.value(result), {
    onNone: (): ReadonlyArray<AuditRowsPage> => [],
    onSome: ({ items }) => items,
  });

  return {
    rows: pages.flatMap((page) => page.rows),
    loading: result.waiting || AsyncResult.isInitial(result),
    more: Option.isSome(Option.flatMap(Array.last(pages), (page) => page.next)),
    problem: AsyncResult.isFailure(result)
      ? Option.some(
          Option.match(AsyncResult.error(result), {
            onNone: () => "The audit trail could not be read.",
            onSome: (error) => error.message,
          }),
        )
      : Option.none(),
  };
}

/**
The trail over the HTTP client `runtime` gives: fetch on the page, a fake one in a test. One atom per set
of filters, keyed by their `searchOf`; writing it reads the page after the last one read.
*/
export function makeAuditTrail(runtime: Atom.AtomRuntime<HttpClient.HttpClient>) {
  const trail = Atom.family((search: string) =>
    runtime.pull(
      Stream.paginate(Option.none<string>(), (cursor) =>
        Effect.map(
          pageOf(search, cursor),
          (page) => [[page], Option.map(page.next, Option.some)] as const,
        ),
      ),
    ),
  );

  return { trail };
}

/** The page's trail, read with fetch from the server that served it. */
export const { trail } = makeAuditTrail(Atom.runtime(FetchHttpClient.layer));

/**
The filters `history`'s URL keeps, so a reload or a copied link shows the same rows. Writing new ones
pushes a history entry, and Back returns to the filters before. Writing the ones shown pushes nothing.
*/
export function makeFilters(history: History): Atom.Writable<AuditFilters> {
  return Atom.keepAlive(
    Atom.writable<AuditFilters, AuditFilters>(
      (get) => {
        get.addFinalizer(history.onPop(() => get.setSelf(filtersOf(history.url()))));

        return filtersOf(history.url());
      },
      (ctx, next) => {
        const url = withFilters(history.url(), next);

        if (url.href === history.url().href) return;

        history.push(url);
        ctx.setSelf(next);
      },
    ),
  );
}

/** The filters the page's own URL keeps. */
export const filters = makeFilters(pageHistory);
