import { createHash, randomBytes } from "node:crypto";
import { type AuditAction, Email, SignInRefusalCode } from "@aobot/domain";
import { Clock, Context, Duration, Effect, Layer, Option, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { Actor, CurrentActor, deployment } from "../../shared/actor.ts";
import { auditRows } from "../audit/public.ts";
import { domainOf, isAllowedDomain } from "./email.ts";
import type { SignInSettings } from "./settings.ts";

/** How long a session lasts from its sign-in, however much it is used. */
export const sessionLifetime = Duration.days(7);

/** A verified address, and what else the provider said of the person behind it. */
export interface VerifiedPerson {
  readonly email: Email;
  /** The provider's own id of the person, `sub`. */
  readonly subject: string;
  readonly name: string;
}

/** A session just made. Its token goes to the person's browser only; the database keeps its hash. */
export interface IssuedSession {
  readonly token: Redacted.Redacted<string>;
}

/** A sign-in was refused, for `code`, after its `auth.refused` row. */
export class SignInRefused extends Schema.TaggedError<SignInRefused>()("SignInRefused", {
  code: SignInRefusalCode,
}) {}

/** A removal did not happen: it could not be stored together with its row. */
export class PersonNotRemoved extends Schema.TaggedError<PersonNotRemoved>()("PersonNotRemoved", {
  message: Schema.String,
}) {}

/** Who signed in may not, for `code`, with what its `auth.refused` row says beside it. */
class NotLetIn extends Schema.TaggedError<NotLetIn>()("NotLetIn", {
  code: SignInRefusalCode.pick(["domain", "removed"]),
  detail: Schema.Record(Schema.String, Schema.String),
}) {}

/** The admins the configuration names could not be recorded. */
export class AdminsNotGranted extends Schema.TaggedError<AdminsNotGranted>()("AdminsNotGranted", {
  message: Schema.String,
}) {}

/** How an `auth.refused` row says why. */
const refusalWords: Readonly<Record<SignInRefusalCode, string>> = {
  domain: "domain not allowed",
  removed: "removed",
  no_verified_email: "no verified email",
  unsupported_email: "unsupported email",
  provider: "provider refused",
  expired: "expired",
  unavailable: "unavailable",
};

/** The hash a session's token is stored and looked up by. */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** An instant as the database writes its own, so the two compare as text. */
function instant(millis: number): string {
  return new Date(millis).toISOString();
}

const decodeKnown = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({ removed: Schema.BooleanFromBit, admin_granted: Schema.BooleanFromBit }),
  ),
);

const decodeRemoved = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ removed_at: Schema.NullOr(Schema.String) })),
);

const decodePeople = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({ email: Email, name: Schema.String, admin_granted: Schema.BooleanFromBit }),
  ),
);

/** The people who may sign in, their sessions, and who was removed. */
export class People extends Context.Service<
  People,
  {
    /**
    Lets `person` in: their domain must be allowed and their address not removed before anyone is
    recorded, then they are recorded,
    made an admin when the configuration says so for the first time, and given a session, with an
    `auth.signed_in` row, all in one transaction. Refused, it writes `auth.refused` and records nothing.
    */
    readonly enter: (person: VerifiedPerson) => Effect.Effect<IssuedSession, SignInRefused>;
    /**
    Writes the `auth.refused` row of a sign-in refused for `code`, naming the address that tried when the
    provider vouched for one, with `detail`. Only logged when it cannot be written.
    */
    readonly refuse: (
      code: SignInRefusalCode,
      email: Option.Option<Email>,
      detail: Readonly<Record<string, string>>,
    ) => Effect.Effect<void>;
    /** Ends the session of `token`, if it has one. */
    readonly signOut: (token: string) => Effect.Effect<void>;
    /**
    Removes `email`: ends every session of theirs and blocks their address, also one that never signed
    in, with a `person.removed` row, in one transaction. Returns how many sessions it ended, or none when
    the address was already removed, which writes nothing. Their computer is stopped from E3-3 on, when
    each person has their own; no credential they gave is kept, so none needs retiring.
    */
    readonly remove: (email: Email) => Effect.Effect<Option.Option<number>, PersonNotRemoved>;
    /**
    Writes `auth.admin_granted` for every person the configuration made an admin since it was last read,
    and forgets the grant of anyone it no longer names, so naming them again writes it again.
    */
    readonly grantAdmins: Effect.Effect<void, AdminsNotGranted>;
  }
>()("aobot/auth/People") {}

/** {@link People} on the app's database, for the people `settings` lets in. */
export const peopleLayer = (settings: Pick<SignInSettings, "allowedDomains" | "admins">) =>
  Layer.effect(
    People,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const rows = {
        person: yield* auditRows("person"),
        deployment: yield* auditRows("deployment"),
      };

      /** The `allow` row of something done at once, and its `succeeded` outcome. */
      const done = (by: keyof typeof rows, action: AuditAction, detail: Schema.JsonObject) =>
        rows[by]
          .decide("allow", action, detail)
          .pipe(Effect.flatMap((allowRow) => rows[by].outcome(allowRow, "succeeded", {})));

      /** The grant row of `person`, who is its actor, though the configuration made them an admin. */
      const granted = (person: Actor) =>
        done("deployment", "auth.admin_granted", {}).pipe(
          Effect.provideService(CurrentActor, person),
        );

      const refuse = Effect.fn("People.refuse")(function* (
        code: SignInRefusalCode,
        email: Option.Option<Email>,
        detail: Readonly<Record<string, string>>,
      ) {
        yield* rows.person
          .refuse("deny", "auth.refused", { reason: refusalWords[code], ...detail })
          .pipe(Effect.provideService(CurrentActor, Actor.cases.Visitor.make({ email })));
      });

      const enter = Effect.fn("People.enter")(function* (person: VerifiedPerson) {
        const { email } = person;
        const now = yield* Clock.currentTimeMillis;
        const token = randomBytes(32).toString("base64url");
        const actor = Actor.cases.Person.make({ email, name: person.name });

        const entered = Effect.gen(function* () {
          if (!isAllowedDomain(email, settings.allowedDomains)) {
            return yield* new NotLetIn({ code: "domain", detail: { domain: domainOf(email) } });
          }

          const [known] = yield* sql`
            SELECT removed_at IS NOT NULL AS removed, admin_granted FROM people WHERE email = ${email}
          `.pipe(Effect.flatMap(decodeKnown));

          // Read inside the transaction, so a removal committed since the provider answered still counts.
          if (known?.removed ?? false) return yield* new NotLetIn({ code: "removed", detail: {} });

          const admin = settings.admins.has(email);

          // The first `sub` stays: a provider that hands the address to someone else gives them a new
          // one, which the person's row does not take on.
          yield* sql`
            INSERT INTO people (email, subject, name, admin_granted, last_signed_in)
            VALUES (${email}, ${person.subject}, ${person.name}, ${admin}, ${instant(now)})
            ON CONFLICT (email) DO UPDATE SET
              subject = coalesce(people.subject, excluded.subject),
              name = excluded.name,
              admin_granted = excluded.admin_granted,
              last_signed_in = excluded.last_signed_in
          `;
          yield* sql`DELETE FROM sessions WHERE email = ${email} AND expires_at <= ${instant(now)}`;
          yield* sql`
            INSERT INTO sessions (token_hash, email, expires_at)
            VALUES (${tokenHash(token)}, ${email}, ${instant(now + Duration.toMillis(sessionLifetime))})
          `;

          yield* done("person", "auth.signed_in", {});

          if (admin && !(known?.admin_granted ?? false)) yield* granted(actor);
        }).pipe(sql.withTransaction, Effect.provideService(CurrentActor, actor));

        yield* entered.pipe(
          Effect.catchTags({
            NotLetIn: ({ code, detail }) =>
              Effect.andThen(
                refuse(code, Option.some(email), detail),
                Effect.fail(new SignInRefused({ code })),
              ),
            SqlError: (error) => unavailable(email, error.message),
            SchemaError: (error) => unavailable(email, error.message),
            AuditWriteFailed: (error) => unavailable(email, error.message),
          }),
        );

        return { token: Redacted.make(token) };
      });

      /** Refuses a sign-in the database could not record. */
      const unavailable = (email: Email, reason: string) =>
        Effect.logError("A sign-in could not be recorded").pipe(
          Effect.annotateLogs({ reason }),
          Effect.andThen(refuse("unavailable", Option.some(email), {})),
          Effect.andThen(Effect.fail(new SignInRefused({ code: "unavailable" }))),
        );

      const signOut = Effect.fn("People.signOut")(function* (token: string) {
        yield* sql`DELETE FROM sessions WHERE token_hash = ${tokenHash(token)}`.pipe(
          Effect.catchTag("SqlError", (error) =>
            Effect.logWarning("A session could not be ended").pipe(
              Effect.annotateLogs({ reason: error.message }),
            ),
          ),
        );
      });

      const notRemoved = (error: { readonly message: string }) =>
        new PersonNotRemoved({ message: error.message });

      const remove = Effect.fn("People.remove")(function* (email: Email) {
        return yield* Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;

          const [known] = yield* sql`SELECT removed_at FROM people WHERE email = ${email}`.pipe(
            Effect.flatMap(decodeRemoved),
          );

          if (known?.removed_at != null) return Option.none<number>();

          yield* sql`
            INSERT INTO people (email, removed_at) VALUES (${email}, ${instant(now)})
            ON CONFLICT (email) DO UPDATE SET removed_at = excluded.removed_at
          `;

          const ended =
            yield* sql`DELETE FROM sessions WHERE email = ${email} RETURNING token_hash`;

          yield* done("deployment", "person.removed", { person: email, sessions: ended.length });

          return Option.some(ended.length);
        }).pipe(
          sql.withTransaction,
          Effect.provideService(CurrentActor, deployment),
          Effect.mapError(notRemoved),
        );
      });

      const grantAdmins = Effect.gen(function* () {
        const people = yield* sql`
          SELECT email, name, admin_granted FROM people WHERE removed_at IS NULL
        `.pipe(Effect.flatMap(decodePeople));

        yield* Effect.forEach(
          people.filter(({ email, admin_granted }) => settings.admins.has(email) !== admin_granted),
          ({ email, name }) => {
            const admin = settings.admins.has(email);

            return sql`UPDATE people SET admin_granted = ${admin} WHERE email = ${email}`.pipe(
              Effect.andThen(
                admin ? granted(Actor.cases.Person.make({ email, name })) : Effect.void,
              ),
              sql.withTransaction,
            );
          },
          { discard: true },
        );
      }).pipe(
        Effect.mapError((error) => new AdminsNotGranted({ message: error.message })),
        Effect.withSpan("People.grantAdmins"),
      );

      return People.of({ enter, refuse, signOut, remove, grantAdmins });
    }),
  );
