import { Schema } from "effect";
import { RpcMiddleware } from "effect/rpc";

/**
An email address as sign-in compares it: lower-cased, with its domain in ASCII. It is a person's id on
every audit row they cause.
*/
export const Email = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[^\s@A-Z]+@[^\s@A-Z]+$/u)),
  Schema.brand("Email"),
);

/** A decoded {@link Email}. */
export type Email = typeof Email.Type;

/** A signed-in person, as the page shows them. */
export const Person = Schema.Struct({ email: Email, name: Schema.String });

/** A decoded {@link Person}. */
export type Person = typeof Person.Type;

/**
Who the page is open for, as `GET /auth/session` answers: a signed-in person, the one person of a server in
single-user mode, or nobody yet. The page opens no RPC socket before it reads `SignedIn` or `SingleUser`.
*/
export const SessionState = Schema.TaggedUnion({
  SignedIn: { person: Person },
  SingleUser: {},
  SignedOut: {},
});

/** A decoded {@link SessionState}. */
export type SessionState = typeof SessionState.Type;

/** Why a sign-in was refused, as the server names it to the page in `/?signin=<code>`. */
export const SignInRefusalCode = Schema.Literals([
  "domain",
  "removed",
  "no_verified_email",
  "provider",
  "expired",
  "unavailable",
]);

/** A decoded {@link SignInRefusalCode}. */
export type SignInRefusalCode = typeof SignInRefusalCode.Type;

/** What the sign-in screen says for each refusal. */
export const signInRefusalWords: Readonly<Record<SignInRefusalCode, string>> = {
  domain: "Addresses at that domain cannot sign in here.",
  removed: "This address was removed from aobot. Ask an admin to let you back in.",
  no_verified_email: "Your company account has no verified email address.",
  provider: "Sign-in was cancelled or refused by your company account.",
  expired: "That sign-in took too long or was already used. Try again.",
  unavailable: "Sign-in is unavailable right now. Try again in a moment.",
};

/**
The call came without a live session: none, one that expired or was signed out, one of a person who was
removed, or one of an address that may no longer sign in.
*/
export class SignedOut extends Schema.TaggedError<SignedOut>()("SignedOut", {}) {}

/** What the page says when the server answers a call with {@link SignedOut}. */
export const signedOutWords = "You are signed out. Reload the page to sign in again.";

/** On every RPC group: the server learns who each call is for, and refuses it with {@link SignedOut}. */
export class SignedIn extends RpcMiddleware.Service<SignedIn>()("aobot/SignedIn", {
  error: SignedOut,
}) {}
