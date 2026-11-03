import type { Email } from "@aobot/domain";
import { type Array, Layer } from "effect";
import { auditLogLayer } from "../../audit/public.ts";
import { identitySignIn } from "../identity.ts";
import { authDatabaseAt } from "../migrations.ts";
import { peopleLayer } from "../people.ts";

/** A fresh in-memory {@link authDatabaseAt}, one per test. */
export const testAuthDatabase = authDatabaseAt(":memory:").pipe(Layer.fresh);

/**
One server's sign-in on the test's database: `People` and `Identity`, letting in `allowedDomains`, only
`example.com` unless told, with `admins` its admins.
*/
export const testSignIn = (
  settings: {
    readonly allowedDomains?: Array.NonEmptyReadonlyArray<string>;
    readonly admins?: ReadonlyArray<Email>;
  } = {},
) => {
  const signIn = {
    allowedDomains: settings.allowedDomains ?? ["example.com"],
    admins: new Set(settings.admins ?? []),
  };

  return Layer.mergeAll(peopleLayer(signIn), identitySignIn(signIn)).pipe(
    Layer.provide(auditLogLayer),
  );
};
