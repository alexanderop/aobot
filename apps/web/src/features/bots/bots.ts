import { Effect, Schedule } from "effect";
import { Atom } from "effect/reactivity";
import { BotClient } from "./bot-client.ts";

/**
The Bots the server knows, asked for once and kept for as long as the page is open. Asked again every two
seconds until the server answers.
*/
export const botList = Atom.keepAlive(
  BotClient.runtime.atom(
    Effect.gen(function* () {
      const client = yield* BotClient;

      return yield* client("Bots.list", undefined);
    }).pipe(Effect.retry(Schedule.spaced("2 seconds"))),
  ),
);
