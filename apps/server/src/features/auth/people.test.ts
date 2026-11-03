import { Email } from "@aobot/domain";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Redacted } from "effect";
import { Headers } from "effect/http";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { actorId } from "../../shared/actor.ts";
import { recordedSpans } from "../../shared/testing/recorded-spans.ts";
import { auditLogLayer, migrateAudit } from "../audit/public.ts";
import { Identity, identitySignIn } from "./identity.ts";
import { sessionCookie } from "./sessions.ts";
import { migrateAuth } from "./migrations.ts";
import { People, peopleLayer, type VerifiedPerson } from "./people.ts";

const database = Layer.effectDiscard(Effect.all([migrateAudit, migrateAuth])).pipe(
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
  Layer.fresh,
);

/** One server's sign-in on the test's database, letting in `domains`, with `admins` its admins. */
function signingIn(
  domains: ReadonlyArray<string> = ["example.com"],
  admins: ReadonlyArray<string> = [],
) {
  const settings = {
    allowedDomains: [domains[0] ?? "example.com", ...domains.slice(1)] as const,
    admins: new Set(admins.map((admin) => Email.make(admin))),
  };

  return Layer.mergeAll(peopleLayer(settings), identitySignIn(settings)).pipe(
    Layer.provide(auditLogLayer),
  );
}

const person = (email: string, name: string): VerifiedPerson => ({
  email: Email.make(email),
  subject: `sub-${name}`,
  name,
});

const alice = person("alice@example.com", "Alice");

const mallory = person("mallory@other.com", "Mallory");

const enter = (who: VerifiedPerson) => People.use((people) => people.enter(who));

/** Who the session cookie of `token` is for now, by address, or none. */
const whoIs = (token: Redacted.Redacted<string>) =>
  Identity.use((identity) =>
    identity.resolve(Headers.fromInput({ cookie: `${sessionCookie}=${Redacted.value(token)}` })),
  ).pipe(Effect.map(Option.map(actorId)));

/** Each audit row as `action · decision`, the actor it names, and its reason when it gives one. */
const trail = SqlClient.SqlClient.use((sql) =>
  Effect.map(
    sql`
      SELECT action, decision, actor_id, coalesce(json_extract(detail, '$.reason'), '') AS reason
      FROM audit_rows ORDER BY seq
    `,
    (rows) =>
      rows.map((row) =>
        [`${String(row["action"])} · ${String(row["decision"])}`, row["actor_id"], row["reason"]]
          .filter((part) => part !== "")
          .join(" | "),
      ),
  ),
);

const count = (table: "people" | "sessions") =>
  SqlClient.SqlClient.use((sql) =>
    Effect.map(
      table === "people"
        ? sql`SELECT count(*) AS n FROM people`
        : sql`SELECT count(*) AS n FROM sessions`,
      ([row]) => row?.["n"],
    ),
  );

describe("signing in", () => {
  it.effect("lets an allowed address in with a session, recorded as theirs", () =>
    Effect.gen(function* () {
      const { token } = yield* enter(alice);

      expect(yield* whoIs(token)).toEqual(Option.some("alice@example.com"));
      expect(yield* trail).toEqual([
        "auth.signed_in · allow | alice@example.com",
        "auth.signed_in · succeeded | alice@example.com",
      ]);
      expect(
        JSON.stringify(yield* SqlClient.SqlClient.use((sql) => sql`SELECT * FROM sessions`)),
      ).not.toContain(Redacted.value(token));
    }).pipe(Effect.provide(signingIn()), Effect.provide(database)),
  );

  it.effect("refuses mallory@other.com before anyone is recorded", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(enter(mallory));

      expect(refused.code).toBe("domain");
      expect(yield* count("people")).toBe(0);
      expect(yield* count("sessions")).toBe(0);
      expect(yield* trail).toEqual([
        "auth.refused · deny | mallory@other.com | domain not allowed",
      ]);
    }).pipe(Effect.provide(signingIn()), Effect.provide(database)),
  );

  it.effect(
    "stops a domain's next sign-in, and its open sessions, once it is no longer allowed",
    () =>
      Effect.gen(function* () {
        const { token } = yield* enter(alice).pipe(Effect.provide(signingIn(["example.com"])));

        const narrowed = signingIn(["example.org"]);
        const refused = yield* Effect.flip(enter(alice)).pipe(Effect.provide(narrowed));

        expect(refused.code).toBe("domain");
        expect(yield* whoIs(token).pipe(Effect.provide(narrowed))).toEqual(Option.none());
        expect(yield* count("sessions")).toBe(1);
      }).pipe(Effect.provide(database)),
  );

  it.effect("ends a session after its lifetime, however much it was used", () =>
    Effect.gen(function* () {
      const { token } = yield* enter(alice);

      yield* TestClock.adjust("6 days");
      expect(yield* whoIs(token)).toEqual(Option.some("alice@example.com"));

      yield* TestClock.adjust("1 day");
      expect(yield* whoIs(token)).toEqual(Option.none());
    }).pipe(Effect.provide(signingIn()), Effect.provide(database)),
  );

  it.effect("reads a session without starting a trace, as every request and call does", () => {
    const tracing = recordedSpans();

    return Effect.gen(function* () {
      const { token } = yield* enter(alice);
      const before = tracing.spans.length;

      expect(yield* whoIs(token)).toEqual(Option.some("alice@example.com"));
      expect(tracing.spans.slice(before)).toEqual([]);
    }).pipe(Effect.provide(signingIn()), Effect.provide(database), Effect.provide(tracing.layer));
  });

  it.effect("ends only the session that signs out", () =>
    Effect.gen(function* () {
      const first = yield* enter(alice);
      const second = yield* enter(alice);

      yield* People.use((people) => people.signOut(Redacted.value(first.token)));

      expect(yield* whoIs(first.token)).toEqual(Option.none());
      expect(yield* whoIs(second.token)).toEqual(Option.some("alice@example.com"));
    }).pipe(Effect.provide(signingIn()), Effect.provide(database)),
  );
});

describe("removing a person", () => {
  it.effect("ends their sessions, and refuses them when they sign in again", () =>
    Effect.gen(function* () {
      const { token } = yield* enter(alice);

      const removed = yield* People.use((people) => people.remove(alice.email));
      const refused = yield* Effect.flip(enter(alice));

      expect(removed).toEqual(Option.some(1));
      expect(refused.code).toBe("removed");
      expect(yield* whoIs(token)).toEqual(Option.none());
      expect(yield* count("sessions")).toBe(0);
      expect(yield* trail).toEqual([
        "auth.signed_in · allow | alice@example.com",
        "auth.signed_in · succeeded | alice@example.com",
        "person.removed · allow | deployment",
        "person.removed · succeeded | deployment",
        "auth.refused · deny | alice@example.com | removed",
      ]);
    }).pipe(Effect.provide(signingIn()), Effect.provide(database)),
  );

  it.effect("blocks an address that never signed in, and writes nothing when run again", () =>
    Effect.gen(function* () {
      const bob = person("bob@example.com", "Bob");

      const first = yield* People.use((people) => people.remove(bob.email));
      const again = yield* People.use((people) => people.remove(bob.email));
      const refused = yield* Effect.flip(enter(bob));

      expect([first, again]).toEqual([Option.some(0), Option.none()]);
      expect(refused.code).toBe("removed");
      expect((yield* trail).filter((row) => row.startsWith("person.removed"))).toHaveLength(2);
    }).pipe(Effect.provide(signingIn()), Effect.provide(database)),
  );
});

describe("admins by configuration", () => {
  it.effect("records a person made an admin once, and again only once they were named anew", () =>
    Effect.gen(function* () {
      const asAdmin = signingIn(["example.com"], ["alice@example.com"]);

      const grants = Effect.map(trail, (rows) =>
        rows.filter((row) => row === "auth.admin_granted · allow | alice@example.com"),
      );

      yield* enter(alice).pipe(Effect.provide(asAdmin));
      yield* enter(alice).pipe(Effect.provide(asAdmin));
      expect(yield* grants).toHaveLength(1);

      yield* People.use((people) => people.grantAdmins).pipe(Effect.provide(signingIn()));
      yield* People.use((people) => people.grantAdmins).pipe(Effect.provide(asAdmin));
      yield* People.use((people) => people.grantAdmins).pipe(Effect.provide(asAdmin));
      expect(yield* grants).toHaveLength(2);
    }).pipe(Effect.provide(database)),
  );
});
