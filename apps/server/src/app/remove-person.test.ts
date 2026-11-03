import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Email } from "@aobot/domain";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Redacted } from "effect";
import { Headers } from "effect/http";
import { auditLogLayer, migrateAudit } from "../features/audit/public.ts";
import {
  Identity,
  identitySignIn,
  migrateAuth,
  People,
  peopleLayer,
  sessionCookie,
} from "../features/auth/public.ts";

const command = fileURLToPath(new URL("./remove-person.ts", import.meta.url));

const signIn = {
  OIDC_ISSUER: "https://login.example.com",
  OIDC_CLIENT_ID: "aobot",
  OIDC_CLIENT_SECRET: "secret",
  SIGNIN_ALLOWED_EMAIL_DOMAINS: "example.com",
};

const settings = { allowedDomains: ["example.com"] as const, admins: new Set<Email>() };

/** The command run as an operator would run it, on the database at `databasePath`. */
function removeAs(databasePath: string, address: string) {
  return Effect.promise(() =>
    promisify(execFile)("node", [command, address], {
      env: { PATH: process.env["PATH"], DATABASE_PATH: databasePath, ...signIn },
    }),
  );
}

describe("vp run people:remove", () => {
  it.live(
    "ends a running server's session for alice at its next request, and says so once",
    () => {
      const databasePath = join(mkdtempSync(join(tmpdir(), "aobot-remove-")), "aobot.db");

      const server = Layer.mergeAll(identitySignIn(settings), peopleLayer(settings)).pipe(
        Layer.provide(auditLogLayer),
        Layer.provideMerge(
          Layer.effectDiscard(Effect.all([migrateAudit, migrateAuth])).pipe(
            Layer.provideMerge(SqliteClient.layer({ filename: databasePath })),
          ),
        ),
      );

      return Effect.gen(function* () {
        const { token } = yield* People.use((people) =>
          people.enter({ email: Email.make("alice@example.com"), subject: "a", name: "Alice" }),
        );

        const cookie = Headers.fromInput({ cookie: `${sessionCookie}=${Redacted.value(token)}` });
        const resolve = Identity.use((identity) => identity.resolve(cookie));

        expect(Option.isSome(yield* resolve)).toBe(true);

        const first = yield* removeAs(databasePath, "Alice@Example.com");
        const again = yield* removeAs(databasePath, "alice@example.com");

        expect(first.stdout).toContain("Removed alice@example.com: 1 session ended");
        expect(again.stdout).toContain("alice@example.com was already removed.");
        expect(yield* resolve).toEqual(Option.none());
      }).pipe(Effect.provide(server));
    },
    30_000,
  );
});
