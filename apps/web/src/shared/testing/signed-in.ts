import { Caller, CallerActor, SignedIn } from "@aobot/domain";
import { Effect, Layer } from "effect";

/** The server's {@link SignedIn} for a client tested against fake handlers: every call is the single user's. */
export const signedIn = Layer.succeed(
  SignedIn,
  SignedIn.of((effect) =>
    Effect.provideService(effect, Caller, CallerActor.cases.SingleUser.make({})),
  ),
);
