import { Layer } from "effect";
import { signedInGate, sessionRoute } from "./http.ts";
import { identitySignIn, identitySingleUser } from "./identity.ts";
import { People, peopleLayer } from "./people.ts";
import { AuthSettings } from "./settings.ts";

/**
What the server wires for `settings`: `identity`, who each request and RPC call is for, which the RPC
socket's {@link signedInRpc} reads too; and `http`, the gate in front of every route, `/auth/*`, and in
sign-in mode the admins the configuration names, recorded at start-up. `shell` is the web app's page,
which a signed-out person opening any page is sent.
*/
export const authLayers = (settings: AuthSettings, shell: string) =>
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
        Layer.effectDiscard(People.use((people) => people.grantAdmins)),
      ).pipe(Layer.provide(peopleLayer(signIn))),
    }),
  });

export { checkSingleUserAddress, lookupLayer } from "./addresses.ts";

export { signedInRpc } from "./http.ts";

export { migrateAuth } from "./migrations.ts";

export { authConfig, AuthSettings } from "./settings.ts";
