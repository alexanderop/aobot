import { BotId, type BotSummary, ConversationId } from "@aobot/domain";
import { type Array, Data, Option, Schema } from "effect";
import { OpenOutcome } from "../features/chat/public.ts";

/** Which Bot the page has open, and which of its conversations. Both live in the URL, as `bot` and `c`. */
export interface Selection {
  readonly bot: BotId;
  readonly conversation: ConversationId;
}

/**
What the person asks the page to show: a Bot, on the last conversation the page had with it; one of their
conversations; or a new conversation with a Bot.
*/
export type Choice = Data.TaggedEnum<{
  Bot: { readonly bot: BotId };
  Conversation: { readonly selection: Selection };
  New: { readonly bot: BotId };
}>;

/** Constructors and matchers for {@link Choice}. */
export const Choice = Data.taggedEnum<Choice>();

/** The last conversation the server opened for the page with each Bot. */
export type Memory = ReadonlyMap<BotId, ConversationId>;

const decodeBot = Schema.decodeUnknownOption(BotId);

const decodeConversation = Schema.decodeUnknownOption(ConversationId);

/** `bot`'s last conversation, or `fresh` when the page has none for it. */
function pickBot(bot: BotId, memory: Memory, fresh: ConversationId): Selection {
  return {
    bot,
    conversation: Option.getOrElse(Option.fromNullishOr(memory.get(bot)), () => fresh),
  };
}

/**
What the page opens on: the Bot the URL names when the server knows it, else the first in `bots.yaml`.
The URL's conversation goes with that Bot, or with the first when the URL names no Bot, as a link from
before Bots were picked does. A URL naming a Bot the server does not know, or something that is no Bot
id, opens the first Bot's last conversation, or `fresh`, never the URL's conversation with another Bot.
*/
export function resolveSelection(
  url: URL,
  bots: Array.NonEmptyReadonlyArray<BotSummary>,
  memory: Memory,
  fresh: ConversationId,
): Selection {
  const first = pickBot(bots[0].id, memory, fresh);

  const conversation = Option.flatMap(Option.fromNullishOr(url.searchParams.get("c")), (id) =>
    id === "" ? Option.none() : decodeConversation(id),
  );

  const named = url.searchParams.get("bot");

  if (named === null) {
    return Option.match(conversation, {
      onNone: () => first,
      onSome: (id) => ({ bot: first.bot, conversation: id }),
    });
  }

  return Option.match(
    Option.filter(decodeBot(named), (id) => bots.some((known) => known.id === id)),
    {
      onNone: () => first,
      onSome: (bot) =>
        Option.match(conversation, {
          onNone: () => pickBot(bot, memory, fresh),
          onSome: (id) => ({ bot, conversation: id }),
        }),
    },
  );
}

/** `url` showing `selection`, so a reload opens it again. */
export function withSelection(url: URL, selection: Selection): URL {
  const next = new URL(url);
  next.searchParams.set("bot", selection.bot);
  next.searchParams.set("c", selection.conversation);

  return next;
}

/** A link to `bot`, opening its last conversation in whichever tab follows it. */
export function botLink(url: URL, bot: BotId): URL {
  const next = new URL(url);
  next.searchParams.set("bot", bot);
  next.searchParams.delete("c");

  return next;
}

/**
What the page shows once the server answered how `requested` opened: a conversation of another Bot with
its own Bot, one that is not the person's as `fresh` with the same Bot, anything else as it was asked
for. A Bot the server does not know stays selected, with its refusal on screen, until the Bot list the
refusal asks for again says which Bots there are.
*/
export function follow(
  requested: Selection,
  outcome: Option.Option<OpenOutcome>,
  fresh: ConversationId,
): Selection {
  return Option.match(outcome, {
    onNone: () => requested,
    onSome: OpenOutcome.$match({
      Opened: () => requested,
      OfAnotherBot: ({ botId }) => ({ bot: botId, conversation: requested.conversation }),
      UnknownBot: () => requested,
      NotYours: () => ({ bot: requested.bot, conversation: fresh }),
    }),
  });
}

/**
What the page opens next for `choice` made on `current`: a Bot's last conversation, or `fresh` with it, a
conversation, or `fresh` as a new one. None when it shows that already.
*/
export function choose(
  current: Selection,
  choice: Choice,
  memory: Memory,
  fresh: ConversationId,
): Option.Option<Selection> {
  return Choice.$match(choice, {
    Bot: ({ bot }) =>
      bot === current.bot ? Option.none() : Option.some(pickBot(bot, memory, fresh)),
    Conversation: ({ selection }) =>
      selection.conversation === current.conversation ? Option.none() : Option.some(selection),
    New: ({ bot }) => Option.some({ bot, conversation: fresh }),
  });
}

const storageKey = "aobot.conversations";

const StoredMemory = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));

const decodeStored = Schema.decodeUnknownOption(StoredMemory);

/** Where the page mirrors its {@link Memory}: the browser's storage, which may be missing or refuse. */
export type MemoryStorage = () => Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The memory a page stored before, or none where storage is missing, refuses or holds something else. */
export function readMemory(storage: MemoryStorage): Memory {
  try {
    const stored = Option.getOrElse(decodeStored(storage().getItem(storageKey)), () => ({}));

    return new Map(
      Object.entries(stored).flatMap(([bot, conversation]) =>
        Option.toArray(Option.all([decodeBot(bot), decodeConversation(conversation)] as const)),
      ),
    );
  } catch {
    return new Map();
  }
}

/**
`memory` with `selection` remembered, mirrored into storage. What other tabs stored since is taken in
first, so a tab never overwrites another tab's Bots. The page keeps the result either way, as in a private
window.
*/
export function remember(storage: MemoryStorage, memory: Memory, selection: Selection): Memory {
  const next = new Map([...memory, ...readMemory(storage)]).set(
    selection.bot,
    selection.conversation,
  );

  try {
    storage().setItem(storageKey, JSON.stringify(Object.fromEntries(next)));
  } catch {
    // The page still remembers until it is closed.
  }

  return next;
}

/** Forgets every Bot's last conversation in storage, where storage lets it. */
export function forgetMemory(storage: MemoryStorage): void {
  try {
    storage().removeItem(storageKey);
  } catch {
    // Nothing was stored where storage refuses.
  }
}
