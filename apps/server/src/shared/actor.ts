import { Email, Person } from "@aobot/domain";
import { Context, Option, Schema } from "effect";

/** Whose authority something happens on. */
export const Actor = Schema.TaggedUnion({
  /** A person signed in with their company account. */
  Person: Person.fields,
  /** The one person of a server in single-user mode. */
  SingleUser: {},
  /** Someone who tried to sign in and was not let in, by the address the provider vouched for, if any. */
  Visitor: { email: Schema.Option(Email) },
  /** The server acting on its own: a start-up sweep, the pause check, an operator's command. */
  Deployment: {},
});

/** A decoded {@link Actor}. */
export type Actor = typeof Actor.Type;

/** The deployment, whose authority anything outside a request is on. */
export const deployment: Actor = Actor.cases.Deployment.make({});

/** The one person of a server in single-user mode. */
export const singleUser: PersonActor = Actor.cases.SingleUser.make({});

/**
Who the current call is on the authority of. Unprovided, it is the deployment: a row written outside any
request is the server's own, and the gateway refuses a Bot action that is not a person's.
*/
export const CurrentActor = Context.Reference<Actor>("aobot/CurrentActor", {
  defaultValue: () => deployment,
});

/**
How an audit row's `actor_id`, a rule's `actor.id` and a span's `actor.id` name `actor`: a person by
their address.
*/
export const actorId: (actor: Actor) => string = Actor.match({
  Person: ({ email }) => email,
  SingleUser: () => "single-user",
  Visitor: ({ email }) => Option.getOrElse(email, () => "anonymous"),
  Deployment: () => "deployment",
});

/** Someone a Bot may act for, and so every turn runs for: a person signed in, or the single user. */
export type PersonActor = Extract<Actor, { readonly _tag: "Person" | "SingleUser" }>;
