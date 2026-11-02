import { BotRpcs } from "@aobot/domain";
import { Array, Effect } from "effect";
import { botSummary } from "./bot.ts";
import { Bots } from "./bots.ts";

/** The `Bots.*` handlers: the Bots the sidebar lists, as `bots.yaml` lists them. */
export const botHandlers = BotRpcs.toLayer(
  Effect.gen(function* () {
    const summaries = Array.map((yield* Bots).list, botSummary);

    return BotRpcs.of({ "Bots.list": () => Effect.succeed(summaries) });
  }),
);
