import { SessionState } from "@aobot/domain";
import { Context, Effect, Layer, Option, Schema } from "effect";
import type { Headers } from "effect/http";
import { Actor, singleUser } from "../../shared/actor.ts";

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
