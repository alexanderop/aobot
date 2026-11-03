import { Layer } from "effect";
import { signedInGate, sessionRoute } from "./http.ts";
import { identitySignIn, identitySingleUser } from "./identity.ts";
import { People, peopleLayer } from "./people.ts";
import { providerLayer } from "./provider.ts";
import { AuthSettings } from "./settings.ts";
import { signInRoutes } from "./sign-in.ts";

/**
What the server wires for `settings`: `identity`, who each request and RPC call is for, which the RPC
socket's {@link signedInRpc} reads too; and `http`, the gate in front of every route, `/auth/*`, and in
sign-in mode signing in at the provider, which sends people back to `publicUrl`, and the admins the
configuration names, recorded at start-up. `shell` is the web app's page, which a signed-out person
opening any page is sent.
*/
export const authLayers = (settings: AuthSettings, publicUrl: URL, shell: string) =>
  AuthSettings.$match(settings, {
    SingleUser: () => ({
      identity: identitySingleUser,
      http: Layer.mergeAll(signedInGate(shell), sessionRoute),
    }),
    SignIn: ({ signIn }) => ({
      identity: identitySignIn(signIn),
      http: Layer.mergeAll(
        signedInGate(shell),
        sessionRoute,
        signInRoutes(publicUrl).pipe(
          Layer.provide(providerLayer(signIn.provider, new URL("/auth/callback", publicUrl))),
        ),
        Layer.effectDiscard(People.use((people) => people.grantAdmins)),
      ).pipe(Layer.provide(peopleLayer(signIn))),
    }),
  });

export { checkSingleUserAddress, lookupLayer } from "./addresses.ts";

export { signedInRpc } from "./http.ts";

export { normalizeEmail } from "./email.ts";

export { Identity } from "./identity.ts";

export { migrateAuth } from "./migrations.ts";

export { People, peopleLayer } from "./people.ts";

export { sessionCookie } from "./sessions.ts";

export { authConfig, AuthSettings } from "./settings.ts";
