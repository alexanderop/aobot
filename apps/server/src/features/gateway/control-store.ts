import { BotId } from "@aobot/domain";
import { DateTime, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

const decodeHeld = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ bot_id: BotId, since: Schema.DateTimeUtcFromString })),
);

/**
Which Bots' computers a person holds, in the database, so a restart never hands control back to the Bot by
itself. A Bot with no row holds its own.
*/
export const controlStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /** Every Bot a person holds, with since when. */
  const held = Effect.gen(function* () {
    const rows = yield* sql`SELECT bot_id, since FROM bot_control`.pipe(Effect.flatMap(decodeHeld));

    return new Map(rows.map((row) => [row.bot_id, row.since] as const));
  }).pipe(Effect.withSpan("ControlStore.held"));

  const hold = Effect.fn("ControlStore.hold")(function* (bot: BotId, since: DateTime.Utc) {
    yield* sql`
      INSERT INTO bot_control (bot_id, since) VALUES (${bot}, ${DateTime.formatIso(since)})
      ON CONFLICT (bot_id) DO UPDATE SET since = excluded.since
    `;
  });

  const release = Effect.fn("ControlStore.release")(function* (bot: BotId) {
    yield* sql`DELETE FROM bot_control WHERE bot_id = ${bot}`;
  });

  return { held, hold, release };
});
