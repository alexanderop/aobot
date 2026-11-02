import type { BotId } from "@aobot/domain";
import { Array, Context, Effect, FileSystem, Layer, Option, Result, Schema } from "effect";
import type { Bot } from "./bot.ts";
import { readBotsFile } from "./bots-file.ts";

/** Every Bot the server knows, read once at start-up. */
export class Bots extends Context.Service<
  Bots,
  {
    /** In the order the file lists them, so the first is the one the page opens by default. */
    readonly list: Array.NonEmptyReadonlyArray<Bot>;
    readonly get: (id: BotId) => Option.Option<Bot>;
  }
>()("aobot/bots/Bots") {}

/** The bots file could not be read or is not valid, so the server does not start. */
class BotsFileInvalid extends Schema.TaggedError<BotsFileInvalid>()("BotsFileInvalid", {
  message: Schema.String,
}) {}

/** {@link Bots} holding `list`. */
export function botsLayer(list: Array.NonEmptyReadonlyArray<Bot>): Layer.Layer<Bots> {
  const byId = new Map(list.map((bot) => [bot.id, bot] as const));

  return Layer.succeed(Bots, Bots.of({ list, get: (id) => Option.fromNullishOr(byId.get(id)) }));
}

/** {@link Bots} from the YAML file at `path`, failing start-up with the reason when it is not valid. */
export function botsFileLayer(path: string) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      const invalid = (reason: string) =>
        new BotsFileInvalid({ message: `${path} is not a valid bots file: ${reason}` });

      const text = yield* fs
        .readFileString(path)
        .pipe(Effect.mapError((error) => invalid(error.message)));

      return botsLayer(yield* Effect.fromResult(Result.mapError(readBotsFile(text), invalid)));
    }),
  );
}
