import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { authConfig, AuthSettings } from "./settings.ts";

const signIn = {
  OIDC_ISSUER: "https://login.example.com",
  OIDC_CLIENT_ID: "aobot",
  OIDC_CLIENT_SECRET: "secret",
  SIGNIN_ALLOWED_EMAIL_DOMAINS: "example.com",
};

function authFrom(env: Record<string, string>) {
  return authConfig.parse(ConfigProvider.fromEnv({ env }));
}

/** Why the settings in `env` are refused. */
function refusalOf(env: Record<string, string>) {
  return Effect.map(Effect.flip(authFrom(env)), (error) => error.message);
}

describe("authConfig", () => {
  it.effect("signs people in unless single-user mode is set, which needs nothing else", () =>
    Effect.gen(function* () {
      expect(yield* authFrom({ SINGLE_USER: "true" })).toEqual(AuthSettings.SingleUser());
      expect((yield* authFrom(signIn))._tag).toBe("SignIn");
    }),
  );

  it.effect(
    "refuses to start with neither single-user mode nor a provider, naming the setting",
    () =>
      Effect.gen(function* () {
        expect(yield* refusalOf({ SIGNIN_ALLOWED_EMAIL_DOMAINS: "example.com" })).toContain(
          "OIDC_ISSUER",
        );
      }),
  );

  it.effect("refuses to start when no domain may sign in", () =>
    Effect.gen(function* () {
      expect(yield* refusalOf({ ...signIn, SIGNIN_ALLOWED_EMAIL_DOMAINS: " , " })).toContain(
        "SIGNIN_ALLOWED_EMAIL_DOMAINS must name at least one domain",
      );
    }),
  );

  it.effect("refuses a plain-HTTP provider unless it is on this machine", () =>
    Effect.gen(function* () {
      expect(yield* refusalOf({ ...signIn, OIDC_ISSUER: "http://login.example.com" })).toContain(
        "OIDC_ISSUER must use https",
      );
      expect((yield* authFrom({ ...signIn, OIDC_ISSUER: "http://localhost:5556/dex" }))._tag).toBe(
        "SignIn",
      );
    }),
  );

  it.effect("counts any loopback address as this machine", () =>
    Effect.gen(function* () {
      for (const issuer of ["http://127.0.0.2:5556/dex", "http://[::1]:5556/dex"]) {
        expect((yield* authFrom({ ...signIn, OIDC_ISSUER: issuer }))._tag).toBe("SignIn");
      }
    }),
  );

  it.effect(
    "refuses a plain-HTTP internal address of an https provider unless it is on this machine",
    () =>
      Effect.gen(function* () {
        expect(
          yield* refusalOf({ ...signIn, OIDC_ISSUER_INTERNAL_URL: "http://login.internal:5556" }),
        ).toContain("OIDC_ISSUER_INTERNAL_URL must use https");
        expect(
          (yield* authFrom({ ...signIn, OIDC_ISSUER_INTERNAL_URL: "http://127.0.0.1:5556" }))._tag,
        ).toBe("SignIn");
      }),
  );

  it.effect("lets a plain-HTTP provider on this machine be reached inside Compose", () =>
    Effect.gen(function* () {
      const compose = {
        ...signIn,
        OIDC_ISSUER: "http://localhost:5556/dex",
        OIDC_ISSUER_INTERNAL_URL: "http://dex:5556/dex",
      };

      expect((yield* authFrom(compose))._tag).toBe("SignIn");
    }),
  );

  it.effect(
    "reads domains and admins as sign-in compares them, and refuses one it cannot read",
    () =>
      Effect.gen(function* () {
        const settings = yield* authFrom({
          ...signIn,
          SIGNIN_ALLOWED_EMAIL_DOMAINS: "Example.com, exämple.de",
          ADMIN_EMAILS: "Alice@EXAMPLE.com",
        });

        expect(AuthSettings.$is("SignIn")(settings) && settings.signIn.allowedDomains).toEqual([
          "example.com",
          "xn--exmple-cua.de",
        ]);
        expect(AuthSettings.$is("SignIn")(settings) && [...settings.signIn.admins]).toEqual([
          "alice@example.com",
        ]);
        expect(yield* refusalOf({ ...signIn, ADMIN_EMAILS: "alice" })).toContain(
          'ADMIN_EMAILS lists "alice", which is not an email address.',
        );
      }),
  );
});
