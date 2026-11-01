import { FileQuery, FileSaved } from "@aobot/domain";
import { Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { FileTransfers, type TransferFailed } from "../features/gateway/public.ts";
import { ownPagesOnly } from "./own-pages.ts";

/** `handle` of the `path` query parameter, or 400 when there is none. */
function withPath<E, R>(
  handle: (path: string) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
  return HttpServerRequest.schemaSearchParams(FileQuery).pipe(
    Effect.option,
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              { message: "Say which file with ?path=." },
              { status: 400 },
            ),
          ),
        onSome: ({ path }) => handle(path),
      }),
    ),
  );
}

const statusOf = { refused: 403, too_large: 413, failed: 502 } as const satisfies Record<
  TransferFailed["reason"],
  number
>;

function failedReply({ reason, message }: TransferFailed) {
  return Effect.succeed(HttpServerResponse.jsonUnsafe({ message }, { status: statusOf[reason] }));
}

/**
`Content-Disposition` for saving the file as `name`: an ASCII stand-in for browsers that read only
`filename`, and the name itself, percent-encoded, for those that read `filename*`.
*/
function savedAs(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/gu, "_");

  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

const encodeSaved = HttpServerResponse.schemaJson(FileSaved);

/** The upload's own length, or none when it does not say one. */
function declaredLength(request: HttpServerRequest.HttpServerRequest): Option.Option<number> {
  return Option.filter(
    Option.map(Option.fromNullishOr(request.headers["content-length"]), Number),
    Number.isSafeInteger,
  );
}

/**
A person's files, on the same routes as the computer's: `GET /files?path=` sends one file of the Bot's
workspace as it is, and `PUT /files?path=` puts the request's body there, streamed through to the computer
and never held whole. An upload must say its length, so one past the limit is refused before a byte of it
is read. Both refuse with 403 a request from a page that is not this server's own. A `HEAD` is answered
405 without asking the computer.
*/
export const fileRoutes = (publicHost: Option.Option<string>) =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const transfers = yield* FileTransfers;

      yield* router.add("GET", "/files", (request) =>
        // The router answers a HEAD with this handler too, which would ask the computer for the file and
        // audit a download that sends no byte.
        request.method === "HEAD"
          ? Effect.succeed(
              HttpServerResponse.empty({ status: 405, headers: { allow: "GET, PUT" } }),
            )
          : withPath((path) =>
              transfers.download(path).pipe(
                Effect.map(({ name, bytes, body }) =>
                  HttpServerResponse.stream(body, {
                    contentType: "application/octet-stream",
                    contentLength: bytes,
                    headers: {
                      "content-disposition": savedAs(name),
                      "x-content-type-options": "nosniff",
                    },
                  }),
                ),
                Effect.catchTag("TransferFailed", failedReply),
              ),
            ),
      );

      yield* router.add("PUT", "/files", (request) =>
        withPath((path) =>
          Option.match(declaredLength(request), {
            onNone: () =>
              Effect.succeed(
                HttpServerResponse.jsonUnsafe(
                  { message: "Say the upload's length in Content-Length." },
                  { status: 411 },
                ),
              ),
            onSome: (bytes) =>
              transfers
                .upload(path, bytes, request.stream)
                .pipe(Effect.flatMap(encodeSaved), Effect.catchTag("TransferFailed", failedReply)),
          }),
        ),
      );
    }),
  ).pipe(Layer.provide(ownPagesOnly(publicHost).layer));
