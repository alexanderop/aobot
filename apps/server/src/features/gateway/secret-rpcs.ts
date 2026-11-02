import { SecretRpcs } from "@aobot/domain";
import { Effect } from "effect";
import { SecretRequests } from "./secrets.ts";

/** The `Secret.*` handlers: a person answering the secret a Bot asked for, straight to the gateway. */
export const secretHandlers = SecretRpcs.toLayer(
  Effect.gen(function* () {
    const secrets = yield* SecretRequests;

    return SecretRpcs.of({
      "Secret.pending": ({ bot }) => secrets.pending(bot),
      "Secret.answer": ({ bot, request, answer }) => secrets.answer(bot, request, answer),
    });
  }),
);
