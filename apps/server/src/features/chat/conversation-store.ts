import { BotId, ConversationId, type ConversationSummary, keepFirst, Message } from "@aobot/domain";
import { Array, Context, Data, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { actorId, type PersonActor } from "../../shared/actor.ts";

/**
Where a conversation stands for the person asking: free, as nobody has written to it yet; theirs, with
the Bot it belongs to; or someone else's, which an owner-less conversation from before owners also is.
*/
export type Standing = Data.TaggedEnum<{
  Free: {};
  Mine: { readonly bot: BotId };
  NotMine: {};
}>;

/** Constructors and matchers for {@link Standing}. */
export const Standing = Data.taggedEnum<Standing>();

/** How long a preview of a conversation's last message is, at most. */
const previewLimit = 120;

const Owned = Schema.Struct({ bot_id: BotId, owner_id: Schema.NullOr(Schema.String) });

const decodeMessages = Schema.decodeUnknownEffect(Schema.Array(Message));

const decodeOwned = Schema.decodeUnknownEffect(Schema.Array(Owned));

const decodeClaimed = Schema.decodeUnknownEffect(Schema.Tuple([Owned]));

const decodeSummaries = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: ConversationId,
      bot_id: BotId,
      text: Schema.String,
      unread: Schema.BooleanFromBit,
    }),
  ),
);

/** Where a stored conversation stands for `person`. */
function standingOf(
  { bot_id, owner_id }: typeof Owned.Type,
  person: PersonActor,
): Exclude<Standing, { readonly _tag: "Free" }> {
  return owner_id === actorId(person) ? Standing.Mine({ bot: bot_id }) : Standing.NotMine();
}

/** What was said in each conversation, in order, and whose each conversation is. */
export class ConversationStore extends Context.Service<
  ConversationStore,
  {
    /** Where the conversation stands for `person`. */
    readonly standing: (
      conversationId: ConversationId,
      person: PersonActor,
    ) => Effect.Effect<Standing>;
    /**
    Makes a free conversation `person`'s, with `bot`, and says where it then stands for them. Of two people
    claiming one conversation at once, the database lets one have it.
    */
    readonly claim: (
      conversationId: ConversationId,
      bot: BotId,
      person: PersonActor,
    ) => Effect.Effect<Exclude<Standing, { readonly _tag: "Free" }>>;
    /** Append a message. Returns false, storing nothing, when the message id was seen before. */
    readonly append: (conversationId: ConversationId, message: Message) => Effect.Effect<boolean>;
    /** Every message, oldest first. Empty for a conversation never written to. */
    readonly messages: (conversationId: ConversationId) => Effect.Effect<ReadonlyArray<Message>>;
    /** Marks every message stored so far as seen by the conversation's owner. */
    readonly markRead: (conversationId: ConversationId) => Effect.Effect<void>;
    /** `person`'s conversations that have a message, the one written to last first. */
    readonly list: (person: PersonActor) => Effect.Effect<ReadonlyArray<ConversationSummary>>;
  }
>()("aobot/chat/ConversationStore") {}

/** {@link ConversationStore} on the app's SQLite database. */
export const conversationStoreLayer = Layer.effect(
  ConversationStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const standing = Effect.fn("ConversationStore.standing")(function* (
      conversationId: ConversationId,
      person: PersonActor,
    ) {
      const rows = yield* sql`
        SELECT bot_id, owner_id FROM conversations WHERE id = ${conversationId}
      `.pipe(Effect.flatMap(decodeOwned), Effect.orDie);

      return Option.match(Array.head(rows), {
        onNone: (): Standing => Standing.Free(),
        onSome: (row) => standingOf(row, person),
      });
    });

    const claim = Effect.fn("ConversationStore.claim")(function* (
      conversationId: ConversationId,
      bot: BotId,
      person: PersonActor,
    ) {
      // The no-op update makes RETURNING answer the stored row when another claim got there first.
      const [row] = yield* sql`
        INSERT INTO conversations (id, bot_id, owner_id)
        VALUES (${conversationId}, ${bot}, ${actorId(person)})
        ON CONFLICT (id) DO UPDATE SET id = id
        RETURNING bot_id, owner_id
      `.pipe(Effect.flatMap(decodeClaimed), Effect.orDie);

      return standingOf(row, person);
    });

    const append = Effect.fn("ConversationStore.append")(function* (
      conversationId: ConversationId,
      message: Message,
    ) {
      const inserted = yield* sql`
        INSERT INTO messages (id, conversation_id, role, text)
        VALUES (${message.id}, ${conversationId}, ${message.role}, ${message.text})
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `.pipe(Effect.orDie);

      return inserted.length > 0;
    });

    const messages = Effect.fn("ConversationStore.messages")(function* (
      conversationId: ConversationId,
    ) {
      const rows = yield* sql`
        SELECT id, role, text FROM messages WHERE conversation_id = ${conversationId} ORDER BY seq
      `.pipe(Effect.orDie);

      return yield* decodeMessages(rows).pipe(Effect.orDie);
    });

    const markRead = Effect.fn("ConversationStore.markRead")(function* (
      conversationId: ConversationId,
    ) {
      yield* sql`
        UPDATE conversations
        SET read_seq = coalesce(
          (SELECT max(seq) FROM messages WHERE conversation_id = ${conversationId}),
          0
        )
        WHERE id = ${conversationId}
      `.pipe(Effect.orDie);
    });

    const list = Effect.fn("ConversationStore.list")(function* (person: PersonActor) {
      const rows = yield* sql`
        SELECT conversations.id, conversations.bot_id, last.text,
          EXISTS (
            SELECT 1 FROM messages AS reply
            WHERE reply.conversation_id = conversations.id AND reply.role = 'assistant'
              AND reply.seq > conversations.read_seq
          ) AS unread
        FROM conversations
        JOIN messages AS last ON last.seq = (
          SELECT max(seq) FROM messages WHERE conversation_id = conversations.id
        )
        WHERE conversations.owner_id = ${actorId(person)}
        ORDER BY last.seq DESC
      `.pipe(Effect.flatMap(decodeSummaries), Effect.orDie);

      return rows.map((row): ConversationSummary => ({
        conversationId: row.id,
        botId: row.bot_id,
        preview: keepFirst(row.text, previewLimit),
        unread: row.unread,
      }));
    });

    return ConversationStore.of({ standing, claim, append, messages, markRead, list });
  }),
);
