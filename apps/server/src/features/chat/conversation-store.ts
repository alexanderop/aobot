import { type BotId, type ConversationId, Message } from "@aobot/domain";
import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";

const decodeMessages = Schema.decodeUnknownEffect(Schema.Array(Message));

/** What was said in each conversation, in order. */
export class ConversationStore extends Context.Service<
  ConversationStore,
  {
    /** Record that the conversation exists. Does nothing when it already does. */
    readonly ensure: (conversationId: ConversationId, botId: BotId) => Effect.Effect<void>;
    /** Append a message. A message id seen before is ignored, so a retried send is stored once. */
    readonly append: (conversationId: ConversationId, message: Message) => Effect.Effect<void>;
    /** Every message, oldest first. Empty for a conversation never written to. */
    readonly messages: (conversationId: ConversationId) => Effect.Effect<ReadonlyArray<Message>>;
  }
>()("aobot/chat/ConversationStore") {}

/** {@link ConversationStore} on the app's SQLite database. */
export const conversationStoreLayer = Layer.effect(
  ConversationStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const ensure = Effect.fn("ConversationStore.ensure")(function* (
      conversationId: ConversationId,
      botId: BotId,
    ) {
      yield* sql`
        INSERT INTO conversations (id, bot_id) VALUES (${conversationId}, ${botId})
        ON CONFLICT (id) DO NOTHING
      `.pipe(Effect.orDie);
    });

    const append = Effect.fn("ConversationStore.append")(function* (
      conversationId: ConversationId,
      message: Message,
    ) {
      yield* sql`
        INSERT INTO messages (id, conversation_id, role, text)
        VALUES (${message.id}, ${conversationId}, ${message.role}, ${message.text})
        ON CONFLICT (id) DO NOTHING
      `.pipe(Effect.orDie);
    });

    const messages = Effect.fn("ConversationStore.messages")(function* (
      conversationId: ConversationId,
    ) {
      const rows = yield* sql`
        SELECT id, role, text FROM messages WHERE conversation_id = ${conversationId} ORDER BY seq
      `.pipe(Effect.orDie);

      return yield* decodeMessages(rows).pipe(Effect.orDie);
    });

    return ConversationStore.of({ ensure, append, messages });
  }),
);
