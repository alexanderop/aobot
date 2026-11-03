import { BotId } from "@aobot/domain";
import { Array, Context, Effect, Layer, Schema } from "effect";
import { SqlClient, type SqlError } from "effect/sql";

/** The database could not say which Bots are paused. */
export class PauseUnreadable extends Schema.TaggedError<PauseUnreadable>()("PauseUnreadable", {
  message: Schema.String,
}) {}

const decodeBots = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ bot_id: BotId })));

/**
Which Bots are paused, in the database every server shares, so a pause made on one server holds on all
of them and across restarts.
*/
export class PauseStore extends Context.Service<
  PauseStore,
  {
    /** The Bots paused now. */
    readonly paused: Effect.Effect<ReadonlyArray<BotId>, PauseUnreadable>;
    /** Pauses `bot` on `by`'s authority. True when it was not paused until now. */
    readonly pause: (bot: BotId, by: string) => Effect.Effect<boolean, SqlError.SqlError>;
    /** Lets `bot` run again. True when it was paused until now. */
    readonly resume: (bot: BotId) => Effect.Effect<boolean, SqlError.SqlError>;
  }
>()("aobot/lifecycle/PauseStore") {}

/** {@link PauseStore} on the app's SQLite database. */
export const pauseStoreLayer = Layer.effect(
  PauseStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const paused = sql`SELECT bot_id FROM bot_pauses`.pipe(
      Effect.flatMap(decodeBots),
      Effect.map(Array.map((row) => row.bot_id)),
      Effect.mapError((error) => new PauseUnreadable({ message: error.message })),
      Effect.withSpan("PauseStore.paused"),
    );

    const pause = Effect.fn("PauseStore.pause")(function* (bot: BotId, by: string) {
      const added = yield* sql`
        INSERT INTO bot_pauses (bot_id, paused_by) VALUES (${bot}, ${by})
        ON CONFLICT (bot_id) DO NOTHING
        RETURNING bot_id
      `;

      return added.length > 0;
    });

    const resume = Effect.fn("PauseStore.resume")(function* (bot: BotId) {
      const removed = yield* sql`DELETE FROM bot_pauses WHERE bot_id = ${bot} RETURNING bot_id`;

      return removed.length > 0;
    });

    return PauseStore.of({ paused, pause, resume });
  }),
);
