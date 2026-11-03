import type { Email } from "@aobot/domain";
import { isIP } from "node:net";
import { Array, Config, ConfigProvider, Data, Option, type Redacted, Result } from "effect";
import { reachOf } from "./addresses.ts";
import { normalizeDomain, normalizeEmail } from "./email.ts";

/** The company's OIDC provider, and this server as a client of it. */
interface ProviderSettings {
  /** The issuer as browsers and ID tokens spell it. */
  readonly issuer: URL;
  /**
  Where this server reaches the issuer when it cannot at the issuer's own address, such as `http://dex:5556`
  inside Compose. Tokens are still checked against {@link issuer}.
  */
  readonly internalIssuer: Option.Option<URL>;
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted<string>;
}

/** Who may sign in, and who is an admin. */
export interface SignInSettings {
  readonly provider: ProviderSettings;
  /** The domains whose addresses may sign in, lower-cased and in ASCII. */
  readonly allowedDomains: Array.NonEmptyReadonlyArray<string>;
  /** The addresses made admins by configuration. */
  readonly admins: ReadonlySet<Email>;
}

/**
How people reach this server: each signs in with their company account, or, in single-user mode, every
request is the one person's.
*/
export type AuthSettings = Data.TaggedEnum<{
  SignIn: { readonly signIn: SignInSettings };
  SingleUser: {};
}>;

/** Constructors and matchers for {@link AuthSettings}. */
export const AuthSettings = Data.taggedEnum<AuthSettings>();

/** The entries of `raw`, a comma-separated list, each as `parse` reads it, or the first it cannot read. */
function parseList<A>(
  raw: string,
  parse: (entry: string) => Option.Option<A>,
): Result.Result<ReadonlyArray<A>, string> {
  const values: A[] = [];

  for (const entry of raw.split(",").flatMap((part) => (part.trim() === "" ? [] : [part.trim()]))) {
    const value = parse(entry);

    if (Option.isNone(value)) return Result.fail(entry);
    values.push(value.value);
  }

  return Result.succeed(values);
}

function refuse(message: string) {
  return Config.fail(new ConfigProvider.SourceError({ message }));
}

/** The comma-separated list in `name`, each entry read by `parse`, which names `what` it expects. */
function listConfig<A>(name: string, parse: (entry: string) => Option.Option<A>, what: string) {
  return Config.String(name).pipe(
    Config.withDefault(""),
    Config.flatMap((raw) =>
      Result.match(parseList(raw, parse), {
        onFailure: (entry) =>
          refuse(`${name} lists ${JSON.stringify(entry)}, which is not ${what}.`),
        onSuccess: (values) => Config.succeed(values),
      }),
    ),
  );
}

/** Whether `host`, a URL's host name, is this machine. */
function onThisMachine(host: string): boolean {
  const address = host.replace(/^\[(.*)\]$/u, "$1");

  return address === "localhost" || (isIP(address) !== 0 && reachOf(address) === "loopback");
}

const providerConfig = Config.all({
  issuer: Config.URL("OIDC_ISSUER"),
  internalIssuer: Config.option(Config.URL("OIDC_ISSUER_INTERNAL_URL")),
  clientId: Config.String("OIDC_CLIENT_ID"),
  clientSecret: Config.Redacted("OIDC_CLIENT_SECRET"),
}).pipe(
  // Tokens fetched over plain HTTP can be read and forged on the way, except on this machine.
  Config.flatMap((provider) =>
    provider.issuer.protocol === "https:" || onThisMachine(provider.issuer.hostname)
      ? Config.succeed(provider)
      : refuse(
          `OIDC_ISSUER must use https unless it is on this machine, but is ${provider.issuer.href}.`,
        ),
  ),
);

const signInConfig = Config.all({
  provider: providerConfig,
  allowedDomains: listConfig("SIGNIN_ALLOWED_EMAIL_DOMAINS", normalizeDomain, "a domain").pipe(
    Config.flatMap((domains) =>
      Array.isReadonlyArrayNonEmpty(domains)
        ? Config.succeed(domains)
        : refuse(
            "SIGNIN_ALLOWED_EMAIL_DOMAINS must name at least one domain whose addresses may sign in.",
          ),
    ),
  ),
  admins: listConfig("ADMIN_EMAILS", normalizeEmail, "an email address").pipe(
    Config.map((admins): ReadonlySet<Email> => new Set(admins)),
  ),
});

/**
How people reach this server, from the environment. `SINGLE_USER=true` needs nothing else and is off by
default; otherwise every `OIDC_*` setting and `SIGNIN_ALLOWED_EMAIL_DOMAINS` are required.
*/
export const authConfig: Config.Config<AuthSettings> = Config.Boolean("SINGLE_USER").pipe(
  Config.withDefault(false),
  Config.flatMap((single) =>
    single
      ? Config.succeed<AuthSettings>(AuthSettings.SingleUser())
      : Config.map(signInConfig, (signIn): AuthSettings => AuthSettings.SignIn({ signIn })),
  ),
);
