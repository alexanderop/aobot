import { AuditQuery, type AuditRow, AuditRowsPage } from "@aobot/domain";
import { Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { AuditTrail } from "../features/audit/public.ts";
import { ownPagesOnly } from "./own-pages.ts";

/** A refusal of the request as it was asked, saying why. */
function badRequest(message: string) {
  return Effect.succeed(HttpServerResponse.jsonUnsafe({ message }, { status: 400 }));
}

const encodePage = HttpServerResponse.schemaJson(AuditRowsPage);

const hour = 60 * 60 * 1000;

/**
Grafana Explore showing the trace `traceId` from the Tempo data source, over the hour either side of
`createdAt`, so a Tempo that searches by time still finds it.
*/
function traceLink(grafana: URL, traceId: string, createdAt: string): string {
  const at = Date.parse(createdAt);
  const explore = new URL(`${grafana.href.replace(/\/$/u, "")}/explore`);

  explore.searchParams.set("schemaVersion", "1");
  explore.searchParams.set(
    "panes",
    JSON.stringify({
      trace: {
        datasource: "tempo",
        queries: [
          {
            refId: "A",
            datasource: { type: "tempo", uid: "tempo" },
            queryType: "traceql",
            query: traceId,
          },
        ],
        range: { from: String(at - hour), to: String(at + hour) },
      },
    }),
  );

  return explore.href;
}

/**
The audit trail for the audit page: `GET /audit/rows` answers one {@link AuditRowsPage} for an
{@link AuditQuery}, each row with a link to its trace when `grafana` is set. A query or a cursor it
cannot read is a 400. A request from a page that is not this server's own is a 403.
*/
export const auditRoutes = (publicHost: string, grafana: Option.Option<URL>) =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const trail = yield* AuditTrail;

      const withTraceLink = (row: Omit<AuditRow, "traceUrl">): AuditRow => ({
        ...row,
        traceUrl: Option.flatMap(grafana, (base) =>
          Option.map(row.traceId, (traceId) => traceLink(base, traceId, row.createdAt)),
        ),
      });

      yield* router.add(
        "GET",
        "/audit/rows",
        HttpServerRequest.schemaSearchParams(AuditQuery).pipe(
          Effect.flatMap(trail.page),
          Effect.flatMap(({ rows, next }) => encodePage({ rows: rows.map(withTraceLink), next })),
          Effect.catchTags({
            SchemaError: (error) =>
              badRequest(`The audit query is not one this server reads. ${error.message}`),
            BadCursor: (error) => badRequest(error.message),
          }),
          Effect.orDie,
        ),
      );
    }),
  ).pipe(Layer.provide(ownPagesOnly(publicHost).layer));
