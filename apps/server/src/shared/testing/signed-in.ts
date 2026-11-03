import { SignedIn } from "@aobot/domain";
import { Effect, Layer } from "effect";
import { type Actor, CurrentActor } from "../actor.ts";

/** A {@link SignedIn} that lets every RPC call through as `actor`, for a test that is not about signing in. */
export const signedInAs = (actor: Actor) =>
  Layer.succeed(
    SignedIn,
    SignedIn.of((effect) => Effect.provideService(effect, CurrentActor, actor)),
  );
