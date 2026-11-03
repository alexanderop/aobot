import { NodeRuntime } from "@effect/platform-node";
import { Config, ConfigProvider, Console, Effect, Option } from "effect";
import { auditLogLayer } from "../features/audit/public.ts";
import {
  AuthSettings,
  authConfig,
  authDatabaseAt,
  normalizeEmail,
  People,
  peopleLayer,
} from "../features/auth/public.ts";
import { databasePathConfig } from "./config.ts";

/**
Removes the person whose address is the first argument, as an operator, until admin pages can: `vp run
people:remove alice@example.com`. Their sessions end, so their next request or call is refused, also on a
server running now, and their address is blocked, so signing in again is refused. A stream they have open
runs until it ends. Their computer is stopped from E3-3 on, when each person has their own.
*/
const removal = Effect.gen(function* () {
  const raw = process.argv[2] ?? "";

  const email = yield* Option.match(normalizeEmail(raw), {
    onNone: () =>
      Effect.fail(
        new ConfigProvider.SourceError({
          message: `Usage: vp run people:remove <email>. ${JSON.stringify(raw)} is not an email address.`,
        }),
      ),
    onSome: Effect.succeed,
  });

  const { databasePath, auth } = yield* Config.all({
    databasePath: databasePathConfig,
    auth: authConfig,
  });

  if (!AuthSettings.$is("SignIn")(auth)) {
    return yield* new ConfigProvider.SourceError({
      message: "SINGLE_USER=true has no people to remove: nobody signs in.",
    });
  }

  const ended = yield* People.use((people) => people.remove(email)).pipe(
    Effect.provide(peopleLayer(auth.signIn)),
    Effect.provide(auditLogLayer),
    Effect.provide(authDatabaseAt(databasePath)),
  );

  yield* Console.log(
    Option.match(ended, {
      onNone: () => `${email} was already removed.`,
      onSome: (sessions) =>
        `Removed ${email}: ${sessions} session${sessions === 1 ? "" : "s"} ended, and the address may no longer sign in.`,
    }),
  );
});

NodeRuntime.runMain(removal);
