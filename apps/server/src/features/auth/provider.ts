import { Context, Effect, Layer, Option, Redacted, Ref, Schema } from "effect";
import * as client from "openid-client";
import type { ProviderSettings } from "./settings.ts";

/** What the provider vouched for in a verified ID token. */
export interface Claims {
  readonly subject: string;
  readonly email: Option.Option<string>;
  readonly emailVerified: boolean;
  readonly name: Option.Option<string>;
}

/**
A sign-in in flight, between sending the browser to the provider and its coming back. It lives only in
the browser's short-lived sign-in cookie: its state stops a forged callback, and its nonce and verifier
are of use only to the browser that already holds them.
*/
export const PendingSignIn = Schema.Struct({
  state: Schema.String,
  nonce: Schema.String,
  verifier: Schema.String,
  returnTo: Schema.String,
});

/** A decoded {@link PendingSignIn}. */
export type PendingSignIn = typeof PendingSignIn.Type;

/**
The provider did not vouch for anyone: it refused or the person cancelled (`provider`), the callback does
not belong to the sign-in in flight or came too late (`expired`), or it could not be reached
(`unavailable`). `detail` says what it said, for the row and the log.
*/
export class ProviderFailed extends Schema.TaggedError<ProviderFailed>()("ProviderFailed", {
  code: Schema.Literals(["provider", "expired", "unavailable"]),
  detail: Schema.String,
}) {}

/** The company's OIDC provider: the authorization code flow with PKCE, state and nonce. */
export class Provider extends Context.Service<
  Provider,
  {
    /** Where to send the browser to sign in, and what to remember until it comes back to `returnTo`. */
    readonly begin: (
      returnTo: string,
    ) => Effect.Effect<{ readonly url: URL; readonly pending: PendingSignIn }, ProviderFailed>;
    /** Trades the code in `callback` for the claims of a verified ID token of `pending`'s sign-in. */
    readonly finish: (
      callback: URL,
      pending: PendingSignIn,
    ) => Effect.Effect<Claims, ProviderFailed>;
  }
>()("aobot/auth/Provider") {}

/**
`url` with the issuer's address swapped for `internal`, when it is one of the issuer's. Tokens and the
discovery document still name the issuer, so they are checked against it as ever.
*/
export function reroute(url: string, issuer: URL, internal: URL): string {
  const base = issuer.href.replace(/\/$/u, "");
  const at = internal.href.replace(/\/$/u, "");
  const rest = url.slice(base.length);

  return url.startsWith(base) && (rest === "" || /^[/?#]/u.test(rest)) ? at + rest : url;
}

const IdToken = Schema.Struct({
  sub: Schema.String,
  email: Schema.optionalKey(Schema.String),
  email_verified: Schema.optionalKey(Schema.Boolean),
  name: Schema.optionalKey(Schema.String),
});

const decodeIdToken = Schema.decodeUnknownEffect(IdToken);

/** Whether `host` is this machine, the one place a provider may be reached over plain HTTP. */
function isLoopbackName(host: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(host);
}

/**
{@link Provider} on `settings`, sending the browser back to `redirectUri`. The provider's metadata is read
on first use and kept once read, so the server starts before the provider does. With an internal issuer
address, every request this server makes to the provider goes there.
*/
export const providerLayer = (settings: ProviderSettings, redirectUri: URL) =>
  Layer.effect(
    Provider,
    Effect.gen(function* () {
      const read = yield* Ref.make(Option.none<client.Configuration>());

      const rerouted: client.CustomFetch = (url, options) =>
        fetch(
          Option.match(settings.internalIssuer, {
            onNone: () => url,
            onSome: (internal) => reroute(url, settings.issuer, internal),
          }),
          options,
        );

      const discover = Effect.tryPromise({
        try: () =>
          client.discovery(
            settings.issuer,
            settings.clientId,
            Redacted.value(settings.clientSecret),
            undefined,
            {
              [client.customFetch]: rerouted,
              execute:
                settings.issuer.protocol === "http:" && isLoopbackName(settings.issuer.hostname)
                  ? [client.allowInsecureRequests]
                  : [],
            },
          ),
        catch: (error) =>
          new ProviderFailed({
            code: "unavailable",
            detail: error instanceof Error ? error.message : String(error),
          }),
      }).pipe(Effect.tap((configuration) => Ref.set(read, Option.some(configuration))));

      const configuration = Effect.flatMap(
        Ref.get(read),
        Option.match({ onNone: () => discover, onSome: Effect.succeed }),
      );

      const begin = Effect.fn("Provider.begin")(function* (returnTo: string) {
        const config = yield* configuration;
        const verifier = client.randomPKCECodeVerifier();

        const pending: PendingSignIn = {
          state: client.randomState(),
          nonce: client.randomNonce(),
          verifier,
          returnTo,
        };

        const challenge = yield* Effect.promise(() => client.calculatePKCECodeChallenge(verifier));

        const url = client.buildAuthorizationUrl(config, {
          redirect_uri: redirectUri.href,
          scope: "openid email profile",
          code_challenge: challenge,
          code_challenge_method: "S256",
          state: pending.state,
          nonce: pending.nonce,
        });

        return { url, pending };
      });

      const finish = Effect.fn("Provider.finish")(function* (
        callback: URL,
        pending: PendingSignIn,
      ) {
        const config = yield* configuration;

        const tokens = yield* Effect.tryPromise({
          try: () =>
            client.authorizationCodeGrant(config, callback, {
              pkceCodeVerifier: pending.verifier,
              expectedState: pending.state,
              expectedNonce: pending.nonce,
              idTokenExpected: true,
            }),
          catch: (error) =>
            error instanceof client.ResponseBodyError
              ? new ProviderFailed({
                  // A code is good once, and briefly: a reloaded or slow callback is a stale sign-in.
                  code: error.error === "invalid_grant" ? "expired" : "provider",
                  detail: error.error,
                })
              : new ProviderFailed({
                  code: error instanceof TypeError ? "unavailable" : "provider",
                  detail: error instanceof Error ? error.message : String(error),
                }),
        });

        const claims = yield* decodeIdToken(tokens.claims()).pipe(
          Effect.mapError(
            (error) => new ProviderFailed({ code: "provider", detail: error.message }),
          ),
        );

        return {
          subject: claims.sub,
          email: Option.fromUndefinedOr(claims.email),
          emailVerified: claims.email_verified ?? false,
          name: Option.fromUndefinedOr(claims.name),
        };
      });

      return Provider.of({ begin, finish });
    }),
  );
