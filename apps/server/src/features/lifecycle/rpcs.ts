import { type BotId, PauseRpcs, UnknownBot } from "@aobot/domain";
import { Effect, Option } from "effect";
import { Bots } from "../bots/public.ts";
import { Turns } from "./turns.ts";

/** The `Pause.*` handlers: an admin pausing and resuming a Bot, and the page following which are paused. */
export const pauseHandlers = PauseRpcs.toLayer(
  Effect.gen(function* () {
    const turns = yield* Turns;
    const bots = yield* Bots;

    const known = (botId: BotId) =>
      Option.match(bots.get(botId), {
        onNone: () => Effect.fail(new UnknownBot({ botId })),
        onSome: () => Effect.succeed(botId),
      });

    return PauseRpcs.of({
      "Pause.watch": () => turns.paused,
      "Pause.pause": ({ botId }) => Effect.flatMap(known(botId), turns.pause),
      "Pause.resume": ({ botId }) => Effect.flatMap(known(botId), turns.resume),
    });
  }),
);
