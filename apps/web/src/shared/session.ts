import { SessionState } from "@aobot/domain";
import { Effect, Schema } from "effect";
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
half minute, whenever the window gets focus, and whenever the server refuses a socket or answers a call
`SignedOut`, so a sign-out, an expired session or a removal elsewhere shows the sign-in screen. Every RPC
socket is open only while it says someone is signed in (`rpc-protocol.ts`).
*/
export function makeSession(runtime: Atom.AtomRuntime<HttpClient.HttpClient>) {
  return runtime
    .atom(readSession)
    .pipe(Atom.withRefresh("30 seconds"), Atom.refreshOnWindowFocus, Atom.keepAlive);
}

/** The page's session, read with fetch from the server that served it. */
export const session = makeSession(Atom.runtime(FetchHttpClient.layer));
