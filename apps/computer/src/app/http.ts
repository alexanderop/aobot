import {
  ComputerAction,
  type ComputerActError,
  ComputerActResult,
  tokensMatch,
} from "@aobot/domain";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpRouter, HttpServerResponse, HttpTraceContext } from "effect/http";
import { Browser } from "../features/browser/public.ts";
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

const encodeResult = HttpServerResponse.schemaJson(ComputerActResult);

const decodeAction = Schema.decodeUnknownEffect(ComputerAction);

const act = Effect.fn("Computer.act")(function* (action: ComputerAction) {
  yield* Effect.annotateCurrentSpan("computer.action", action.action);

  if (action.action === "run") return yield* Shell.use((shell) => shell.run(action.command));

  return yield* Browser.use((browser) => browser.act(action));
});

/**
`GET /health`, open so Docker and the server can see the computer is up, and `POST /act`, the only way to
drive the browser and the shell, behind the bearer token. `/act` refuses a caller on the computer itself,
so a command that reads the token out of `/proc` still cannot drive the browser around the gateway.
*/
export const routesLayer = (token: Redacted.Redacted<string>) =>
  Layer.mergeAll(
    HttpRouter.add("GET", "/health", HttpServerResponse.jsonUnsafe({ status: "ok" })),
    HttpRouter.add("POST", "/act", (request) =>
      Effect.gen(function* () {
        if (fromThisComputer(request.remoteAddress)) return forbidden;

        const offered = bearerToken(Option.fromNullishOr(request.headers["authorization"]));

        const authorised = Option.match(offered, {
          onNone: () => false,
          onSome: (candidate) => tokensMatch(Redacted.value(token), candidate),
        });

        if (!authorised) return notAuthorised;

        const action = yield* request.json.pipe(Effect.flatMap(decodeAction), Effect.option);

        if (Option.isNone(action)) {
          return HttpServerResponse.jsonUnsafe(
            { error: "The body is not a computer action." },
            { status: 400 },
          );
        }

        // The caller's span, so the computer's work shows up inside the gateway call that asked for it.
        const parent = HttpTraceContext.fromHeaders(request.headers);
        const run = act(action.value);

        return yield* Option.match(parent, {
          onNone: () => run,
          onSome: (span) => Effect.withParentSpan(run, span),
        }).pipe(
          Effect.flatMap(encodeResult),
          Effect.catchTags({
            ActionRefused: ({ message }) =>
              Effect.succeed(errorReply({ reason: "refused", message }, 403)),
            ActionFailed: ({ message }) =>
              Effect.succeed(errorReply({ reason: "failed", message }, 502)),
            CommandFailed: ({ message }) =>
              Effect.succeed(errorReply({ reason: "failed", message }, 502)),
          }),
        );
      }),
    ),
  );
