import type { SignInRefusalCode } from "@aobot/domain";
import { Duration, Effect, Option, Redacted, Schema } from "effect";
import { type Cookies, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { capText } from "../../shared/tool-result.ts";
import { sessionCookie, sessionToken } from "./identity.ts";
import { normalizeEmail } from "./email.ts";
import { People, sessionLifetime, SignInRefused } from "./people.ts";
import { PendingSignIn, Provider, ProviderFailed } from "./provider.ts";

/** The cookie a sign-in in flight is kept in, between leaving for the provider and coming back. */
const signInCookie = "aobot_signin";

/**
How much of what a callback says went wrong its refusal row keeps: anyone can call the callback, with
any text in its `error`.
*/
const providerErrorLimit = 200;

/** How long a person has to sign in at the provider. */
const signInLifetime = Duration.minutes(10);

const PendingCookie = Schema.fromJsonString(PendingSignIn);

const encodePending = Schema.encodeSync(PendingCookie);

const decodePending = Schema.decodeUnknownOption(PendingCookie);

/**
Where a sign-in may return to: a path on this server, never another site. `//evil.example` and
`/\evil.example` are paths a browser reads as another host, so anything but a plain path is `/`.
*/
export function returnPathOf(raw: Option.Option<string>): string {
  return Option.getOrElse(
    Option.filter(raw, (path) => /^\/(?![/\\])/u.test(path)),
    () => "/",
  );
}

/**
`GET /auth/sign-in` sends the browser to the provider, `GET /auth/callback` lets the person it vouched for
in with a session, and `POST /auth/sign-out` ends it. `publicUrl` is where people open the app: the
callback is read as an address there, never from the request's `Host`. Every refusal writes `auth.refused`
and sends the browser to `/?signin=<code>`.
*/
export const signInRoutes = (publicUrl: URL) =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const provider = yield* Provider;
      const people = yield* People;

      const cookie = (maxAge: Duration.Duration, path: string): Cookies.Cookie["options"] => ({
        httpOnly: true,
        sameSite: "lax",
        secure: publicUrl.protocol === "https:",
        path,
        maxAge,
      });

      const goTo = (location: string) =>
        HttpServerResponse.empty({ status: 303, headers: { location } });

      /** Sends the browser to the sign-in screen, saying why it was refused. */
      const refused = (code: SignInRefusalCode) =>
        goTo(`/?signin=${code}`).pipe(
          HttpServerResponse.expireCookie(signInCookie, { path: "/auth" }),
        );

      yield* router.add(
        "GET",
        "/auth/sign-in",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;

          const returnTo = returnPathOf(
            Option.fromNullishOr(new URL(request.url, publicUrl).searchParams.get("return")),
          );

          const { url, pending } = yield* provider.begin(returnTo);

          return yield* HttpServerResponse.empty({
            status: 302,
            headers: { location: url.href },
          }).pipe(
            HttpServerResponse.setCookie(
              signInCookie,
              encodePending(pending),
              cookie(signInLifetime, "/auth"),
            ),
          );
        }).pipe(
          Effect.catchTag("ProviderFailed", (failed) =>
            Effect.logError("The sign-in provider could not be reached").pipe(
              Effect.annotateLogs({ reason: failed.detail }),
              Effect.andThen(people.refuse("unavailable", Option.none(), {})),
              Effect.andThen(refused("unavailable")),
            ),
          ),
          Effect.orDie,
        ),
      );

      yield* router.add(
        "GET",
        "/auth/callback",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const callback = new URL(request.url, publicUrl);
          const error = callback.searchParams.get("error");

          if (error !== null) {
            return yield* new ProviderFailed({ code: "provider", detail: error });
          }

          const pending = Option.filter(
            Option.flatMap(Option.fromUndefinedOr(request.cookies[signInCookie]), decodePending),
            ({ state }) => state === callback.searchParams.get("state"),
          );

          if (Option.isNone(pending)) {
            return yield* new ProviderFailed({ code: "expired", detail: "no sign-in in flight" });
          }

          const claims = yield* provider.finish(callback, pending.value);

          const email = Option.flatMap(
            Option.filter(claims.email, () => claims.emailVerified),
            normalizeEmail,
          );

          if (Option.isNone(email)) {
            yield* people.refuse("no_verified_email", Option.none(), { subject: claims.subject });

            return yield* new SignInRefused({ code: "no_verified_email" });
          }

          const { token } = yield* people.enter({
            email: email.value,
            subject: claims.subject,
            name: Option.getOrElse(claims.name, () => email.value),
          });

          return yield* goTo(pending.value.returnTo).pipe(
            HttpServerResponse.expireCookie(signInCookie, { path: "/auth" }),
            Effect.flatMap(
              HttpServerResponse.setCookie(
                sessionCookie,
                Redacted.value(token),
                cookie(sessionLifetime, "/"),
              ),
            ),
          );
        }).pipe(
          Effect.catchTags({
            ProviderFailed: (failed) =>
              Effect.logWarning("A sign-in did not come back from the provider").pipe(
                Effect.annotateLogs({ reason: failed.detail }),
                Effect.andThen(
                  people.refuse(failed.code, Option.none(), {
                    error: capText(failed.detail, providerErrorLimit),
                  }),
                ),
                Effect.andThen(refused(failed.code)),
              ),
            SignInRefused: (failed) => refused(failed.code),
          }),
          Effect.orDie,
        ),
      );

      yield* router.add(
        "POST",
        "/auth/sign-out",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;

          yield* Option.match(sessionToken(request.headers), {
            onNone: () => Effect.void,
            onSome: people.signOut,
          });

          return yield* goTo("/").pipe(
            HttpServerResponse.expireCookie(sessionCookie, { path: "/" }),
          );
        }).pipe(Effect.orDie),
      );
    }),
  );
