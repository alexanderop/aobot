import { SessionState, SignedIn, SignedOut } from "@aobot/domain";
import { Effect, Layer, Option, Result } from "effect";
import { HttpPlatform, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { CurrentActor } from "../../shared/actor.ts";
import { Identity, sessionStateOf } from "./identity.ts";

/**
Whether anyone may ask for `path` signed out: signing in itself, the web app's built files, and the health
check.
*/
function isOpen(path: string): boolean {
  return path.startsWith("/auth/") || path.startsWith("/assets/") || path === "/healthz";
}

/** Whether `request` is a person opening a page, as opposed to a page fetching something. */
function isNavigation(request: HttpServerRequest.HttpServerRequest): boolean {
  if (request.method !== "GET") return false;

  const mode = request.headers["sec-fetch-mode"];

  return mode === undefined
    ? (request.headers["accept"] ?? "").includes("text/html")
    : mode === "navigate";
}

/** The path of `request`, without its query. */
function pathOf(request: HttpServerRequest.HttpServerRequest): string {
  return request.url.split("?", 1)[0] ?? "";
}

/**
Every request is answered only for a person signed in, with {@link CurrentActor} set to them for whatever
handles it, so a route added later is covered without a line of its own. Signed out, only signing in, the
web app's files and `/healthz` answer; opening any other page gets the web app at `shell`, which asks the
person to sign in, and anything else a 401. When the session cannot be read, the request is refused with
503 rather than answered signed out.
*/
export const signedInGate = (shell: string) =>
  HttpRouter.middleware(
    Effect.gen(function* () {
      const identity = yield* Identity;
      const platform = yield* HttpPlatform.HttpPlatform;

      return (handle) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const open = isOpen(pathOf(request));

          const resolved = yield* identity.resolve(request.headers).pipe(
            Effect.tapError((error) =>
              Effect.logError("A session could not be read").pipe(
                Effect.annotateLogs({ reason: error.message }),
              ),
            ),
            Effect.result,
          );

          const unanswered = (status: 401 | 503) =>
            open ? handle : Effect.succeed(HttpServerResponse.empty({ status }));

          return yield* Result.match(resolved, {
            onFailure: () => unanswered(503),
            onSuccess: Option.match({
              onSome: (actor) => Effect.provideService(handle, CurrentActor, actor),
              onNone: () =>
                !open && isNavigation(request)
                  ? platform.fileResponse(shell).pipe(Effect.orDie)
                  : unanswered(401),
            }),
          });
        });
    }),
    { global: true },
  );

/**
The server's side of {@link SignedIn}: each RPC call is read again from the session its headers carry, and
runs with {@link CurrentActor} set to that person, or fails with {@link SignedOut}. A message may name a
cookie of its own, but a token counts only once its session is found, so it can only be one the client
already holds.
*/
export const signedInRpc = Layer.effect(
  SignedIn,
  Effect.gen(function* () {
    const identity = yield* Identity;

    return SignedIn.of((effect, { headers }) =>
      identity.resolve(headers).pipe(
        Effect.orDie,
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new SignedOut()),
            onSome: (actor) => Effect.provideService(effect, CurrentActor, actor),
          }),
        ),
      ),
    );
  }),
);

const encodeSession = HttpServerResponse.schemaJson(SessionState);

/** `GET /auth/session`: who the page is open for, read before it opens any RPC socket. */
export const sessionRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const identity = yield* Identity;

    yield* router.add(
      "GET",
      "/auth/session",
      HttpServerRequest.HttpServerRequest.pipe(
        Effect.flatMap((request) => identity.resolve(request.headers)),
        Effect.map(sessionStateOf),
        Effect.flatMap(encodeSession),
        Effect.catchTag("IdentityUnreadable", () =>
          Effect.succeed(HttpServerResponse.empty({ status: 503 })),
        ),
        Effect.orDie,
      ),
    );
  }),
);
