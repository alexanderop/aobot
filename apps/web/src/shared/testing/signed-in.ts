import { SignedIn } from "@aobot/domain";
import { Layer } from "effect";

/** The server's {@link SignedIn} for a client tested against fake handlers: every call goes through. */
export const signedIn = Layer.succeed(
  SignedIn,
  SignedIn.of((effect) => effect),
);
