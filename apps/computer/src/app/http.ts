import type { Writable } from "node:stream";
import {
  ComputerAction,
  type ComputerActError,
  ComputerActResult,
  PersonInput,
  ScreenFrame,
  tokensMatch,
} from "@aobot/domain";
import { NodeHttpServerRequest } from "@effect/platform-node";
import { Effect, Layer, Option, Redacted, Schema, Stream } from "effect";
import {
  HttpRouter,
  type HttpServerRequest,
  HttpServerResponse,
  HttpTraceContext,
} from "effect/http";
import { Socket } from "effect/socket";
import { Browser } from "../features/browser/public.ts";
import { Screencast } from "../features/screen/public.ts";
import { Shell } from "../features/shell/public.ts";
import { fromThisComputer } from "./callers.ts";

function errorReply(error: ComputerActError, status: 403 | 502) {
  return HttpServerResponse.jsonUnsafe(error, { status });
}

const notAuthorised = HttpServerResponse.jsonUnsafe({ error: "Not authorised." }, { status: 401 });

const forbidden = HttpServerResponse.empty({ status: 403 });

/** The token in `Authorization: Bearer <token>`, or none. */
function bearerToken(header: Option.Option<string>): Option.Option<string> {
  return Option.flatMap(header, (value) =>
    Option.fromNullishOr(/^Bearer\s+(\S+)\s*$/iu.exec(value)?.[1]),
  );
}

function guarded<E, R>(
  token: Redacted.Redacted<string>,
  handle: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
  return (request: HttpServerRequest.HttpServerRequest) => {
    if (fromThisComputer(request.remoteAddress)) return Effect.succeed(forbidden);

    const offered = bearerToken(Option.fromNullishOr(request.headers["authorization"]));

    const authorised = Option.match(offered, {
      onNone: () => false,
      onSome: (candidate) => tokensMatch(Redacted.value(token), candidate),
    });

    return authorised ? handle(request) : Effect.succeed(notAuthorised);
  };
}

const encodeResult = HttpServerResponse.schemaJson(ComputerActResult);

const encodeFrame = Schema.encodeSync(Schema.fromJsonString(ScreenFrame));

function drained(connection: Writable): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    if (!connection.writableNeedDrain) return resume(Effect.void);

    const done = () => resume(Effect.void);
    connection.once("drain", done);

    return Effect.sync(() => connection.off("drain", done));
  });
}

/**
`write` returns as soon as ws has the frame, so the next waits for `connection` to drain: meanwhile the
share keeps only the latest, and a reader that stops reading costs about one frame. Draining the reader
alongside is how a close is noticed: it fails the read, and the race stops the writes.
*/
const sendFrames = (socket: Socket.Socket, connection: Writable) =>
  Effect.gen(function* () {
    const { frames } = yield* Screencast;
    const { write } = yield* socket.writer;

    yield* Effect.raceFirst(
      Stream.runForEach(frames, (frame) =>
        write(encodeFrame(frame)).pipe(Effect.andThen(drained(connection))),
      ),
      Stream.runDrain(Socket.toStream(socket)),
    );
  }).pipe(Effect.ignore, Effect.scoped);

const act = Effect.fn("Computer.act")(function* (action: ComputerAction) {
  yield* Effect.annotateCurrentSpan("computer.action", action.action);

  if (action.action === "run") return yield* Shell.use((shell) => shell.run(action.command));

  return yield* Browser.use((browser) => browser.act(action));
});

const input = Effect.fn("Computer.input")(function* (given: PersonInput) {
  yield* Browser.use((browser) => browser.input(given));
});

/** `handle` of the body decoded as `schema`, or 400 saying the body is not `what`. */
function withBody<A, I, E, R>(
  request: HttpServerRequest.HttpServerRequest,
  schema: Schema.Codec<A, I>,
  what: string,
  handle: (body: A) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
  return request.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.option,
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe({ error: `The body is not ${what}.` }, { status: 400 }),
          ),
        onSome: handle,
      }),
    ),
  );
}

/** `effect` inside the caller's span, so the computer's work shows up inside the gateway call that asked for it. */
function withCallerSpan<A, E, R>(
  request: HttpServerRequest.HttpServerRequest,
  effect: Effect.Effect<A, E, R>,
) {
  return Option.match(HttpTraceContext.fromHeaders(request.headers), {
    onNone: () => effect,
    onSome: (span) => Effect.withParentSpan(effect, span),
  });
}

/**
`GET /health`, open so Docker and the server can see the computer is up. `POST /act`, the only way to drive
the browser and the shell, `POST /input`, what a person in control did on the screen, and `GET /stream`, the
screen as a WebSocket of frames, all behind the bearer token. They refuse a caller on the computer itself,
so a command that reads the token out of `/proc` can neither drive the browser around the gateway nor watch
what it shows.
*/
export const routesLayer = (token: Redacted.Redacted<string>) =>
  Layer.mergeAll(
    HttpRouter.add("GET", "/health", HttpServerResponse.jsonUnsafe({ status: "ok" })),
    HttpRouter.add(
      "POST",
      "/act",
      guarded(token, (request) =>
        withBody(request, ComputerAction, "a computer action", (action) =>
          withCallerSpan(request, act(action)).pipe(
            Effect.flatMap(encodeResult),
            Effect.catchTags({
              ActionRefused: ({ message }) =>
                Effect.succeed(errorReply({ reason: "refused", message }, 403)),
              ActionFailed: ({ message }) =>
                Effect.succeed(errorReply({ reason: "failed", message }, 502)),
              CommandFailed: ({ message }) =>
                Effect.succeed(errorReply({ reason: "failed", message }, 502)),
            }),
          ),
        ),
      ),
    ),
    HttpRouter.add(
      "POST",
      "/input",
      guarded(token, (request) =>
        withBody(request, PersonInput, "a person's input", (given) =>
          withCallerSpan(request, input(given)).pipe(
            Effect.as(HttpServerResponse.empty({ status: 204 })),
            Effect.catchTag("ActionFailed", ({ message }) =>
              Effect.succeed(errorReply({ reason: "failed", message }, 502)),
            ),
          ),
        ),
      ),
    ),
    HttpRouter.add(
      "GET",
      "/stream",
      guarded(token, (request) =>
        Effect.gen(function* () {
          const connection = NodeHttpServerRequest.toIncomingMessage(request).socket;

          yield* sendFrames(yield* request.upgrade, connection);

          return HttpServerResponse.empty();
        }),
      ),
    ),
  );
