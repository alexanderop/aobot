import { Email, SessionState } from "@aobot/domain";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { Cookies, type Headers } from "effect/http";
import { SqlClient } from "effect/sql";
import { Actor, singleUser } from "../../shared/actor.ts";
import { isAllowedDomain } from "./email.ts";
import { tokenHash } from "./people.ts";
import type { SignInSettings } from "./settings.ts";

/** The cookie a person's session token is in. */
export const sessionCookie = "aobot_session";

/** The session token `headers` carry, if any. */
export function sessionToken(headers: Headers.Headers): Option.Option<string> {
  return Option.fromUndefinedOr(Cookies.parseHeader(headers["cookie"] ?? "")[sessionCookie]);
}

/**
The database did not answer who a session belongs to. Whoever asked refuses the request for now, and never
signs the person out on a guess.
*/
export class IdentityUnreadable extends Schema.TaggedError<IdentityUnreadable>()(
  "IdentityUnreadable",
  { message: Schema.String },
) {}

/** Who a request is for, read again for every request and every RPC call, so nothing caches a session. */
export class Identity extends Context.Service<
  Identity,
  {
    /**
    The actor the session cookie in `headers` belongs to right now, or none: no session, one that expired
    or was signed out, or one of a person who may no longer sign in.
    */
    readonly resolve: (
      headers: Headers.Headers,
    ) => Effect.Effect<Option.Option<Actor>, IdentityUnreadable>;
  }
>()("aobot/auth/Identity") {}

/** Single-user mode: every request is the one person's. */
export const identitySingleUser = Layer.succeed(
  Identity,
  Identity.of({ resolve: () => Effect.succeed(Option.some(singleUser)) }),
);

const decodeSession = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ email: Email, name: Schema.String })),
);

/**
Sign-in mode: the person of a live session, read from the database on every call, so a sign-out, a
removal or a domain no longer allowed counts at once, also when another process made it.
*/
export const identitySignIn = (settings: Pick<SignInSettings, "allowedDomains">) =>
  Layer.effect(
    Identity,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const lookUp = Effect.fnUntraced(function* (headers: Headers.Headers) {
        const token = sessionToken(headers);

        if (Option.isNone(token)) return Option.none<Actor>();

        const now = new Date(yield* Clock.currentTimeMillis).toISOString();

        const [session] = yield* sql`
          SELECT people.email, people.name FROM sessions JOIN people USING (email)
          WHERE sessions.token_hash = ${tokenHash(token.value)} AND sessions.expires_at > ${now}
            AND people.removed_at IS NULL
        `.pipe(
          Effect.flatMap(decodeSession),
          Effect.mapError((error) => new IdentityUnreadable({ message: error.message })),
        );

        return Option.flatMap(Option.fromUndefinedOr(session), ({ email, name }) =>
          isAllowedDomain(email, settings.allowedDomains)
            ? Option.some(Actor.cases.Person.make({ email, name }))
            : Option.none(),
        );
      });

      return Identity.of({
        // Untraced, its query included: every request and every RPC call reads it, and a root trace
        // each would bury the turns.
        resolve: (headers) => lookUp(headers).pipe(Effect.withTracerEnabled(false)),
      });
    }),
  );

const signedOut = SessionState.cases.SignedOut.make({});

/** What the page is told of who it is open for, from what {@link Identity} resolved. */
export function sessionStateOf(actor: Option.Option<Actor>): SessionState {
  return Option.match(actor, {
    onNone: () => signedOut,
    onSome: Actor.match({
      Person: (person): SessionState =>
        SessionState.cases.SignedIn.make({ person: { email: person.email, name: person.name } }),
      SingleUser: () => SessionState.cases.SingleUser.make({}),
      Visitor: () => signedOut,
      Deployment: () => signedOut,
    }),
  });
}
