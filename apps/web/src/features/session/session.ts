import { SessionState, SignInRefusalCode, signInRefusalWords } from "@aobot/domain";
import { Effect, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { Atom } from "effect/reactivity";

/** The server could not say who the page is open for. */
class SessionUnreadable extends Schema.TaggedError<SessionUnreadable>()("SessionUnreadable", {
  message: Schema.String,
}) {}

const decodeSession = HttpClientResponse.schemaBodyJson(SessionState);

/** Who the page is open for, as `GET /auth/session` answers. */
const readSession = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.get("/auth/session");

  return yield* decodeSession(response);
}).pipe(
  Effect.catchTags({
    HttpClientError: (error) => Effect.fail(new SessionUnreadable({ message: error.message })),
    SchemaError: (error) => Effect.fail(new SessionUnreadable({ message: error.message })),
  }),
);

/**
The session over the HTTP client `runtime` gives: fetch on the page, a fake one in a test. Read again every
half minute and whenever the window gets focus, so a sign-out, an expired session or a removal elsewhere
shows the sign-in screen and closes the page's sockets.
*/
export function makeSession(runtime: Atom.AtomRuntime<HttpClient.HttpClient>) {
  return runtime
    .atom(readSession)
    .pipe(Atom.withRefresh("30 seconds"), Atom.refreshOnWindowFocus, Atom.keepAlive);
}

/** The page's session, read with fetch from the server that served it. */
export const session = makeSession(Atom.runtime(FetchHttpClient.layer));

const decodeCode = Schema.decodeUnknownOption(SignInRefusalCode);

/** What the sign-in screen says of a sign-in the server refused, from the page's query `search`. */
export function refusalOf(search: string): Option.Option<string> {
  return Option.map(Option.fromNullishOr(new URLSearchParams(search).get("signin")), (code) =>
    Option.match(decodeCode(code), {
      onNone: () => "Sign-in did not work. Try again.",
      onSome: (known) => signInRefusalWords[known],
    }),
  );
}

/** Where a sign-in started on the page at `url` returns to: the same page, without the last refusal. */
export function signInHref(url: URL): string {
  const back = new URL(url.href);
  back.searchParams.delete("signin");

  return `/auth/sign-in?return=${encodeURIComponent(back.pathname + back.search)}`;
}
