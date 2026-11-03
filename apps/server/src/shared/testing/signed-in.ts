import { Caller, SignedIn } from "@aobot/domain";
import { Effect, Layer } from "effect";
import { CurrentActor, type PersonActor } from "../actor.ts";

/** A {@link SignedIn} that lets every RPC call through as `actor`, for a test that is not about signing in. */
export const signedInAs = (actor: PersonActor) =>
  Layer.succeed(
    SignedIn,
    SignedIn.of((effect) =>
      effect.pipe(Effect.provideService(Caller, actor), Effect.provideService(CurrentActor, actor)),
    ),
  );
