import { type BotSummary, ConversationId, type OpenConversation } from "@aobot/domain";
import { type Array, Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { botList } from "../features/bots/public.ts";
import { conversation, OpenOutcome } from "../features/chat/public.ts";
import { type History, pageHistory } from "../shared/page-history.ts";
import {
  type Choice,
  choose,
  follow,
  forgetMemory,
  type Memory,
  type MemoryStorage,
  readMemory,
  remember,
  resolveSelection,
  type Selection,
  withSelection,
} from "./selection.ts";

/** What the selection needs of the browser: its URL and history, its storage, and new ids. */
export interface Browser extends History {
  readonly replace: (url: URL) => void;
  readonly storage: MemoryStorage;
  readonly newConversation: () => ConversationId;
}

/** The page's URL, with the conversation a Bot opens on it when the URL names none and nor does memory. */
interface Location {
  readonly url: URL;
  readonly fresh: ConversationId;
}

/** A change of URL: `push` for one the person can go back from, `replace` for a correction. */
interface Navigation {
  readonly url: URL;
  readonly history: "push" | "replace";
}

/** The open of a conversation with a Bot, as the chat feature answers it. */
type Open = (
  opening: typeof OpenConversation.Type,
) => Atom.Atom<AsyncResult.AsyncResult<OpenOutcome, unknown>>;

/**
The page's selection over `browser`, once `bots` says which Bots there are. It reads the Bot and
conversation from the URL, the Bot list and the memory of each Bot's last conversation, then follows what
the server answered when `open` opened that conversation with that Bot. The URL is corrected to show what
the page shows, without a history entry, and a pair the server opened is remembered. Writing a
{@link Choice} opens what it names, with a history entry so Back returns to what was open before.
*/
export function makeSelection(
  browser: Browser,
  bots: Atom.Atom<Option.Option<Array.NonEmptyReadonlyArray<BotSummary>>>,
  open: Open,
): Atom.Writable<Option.Option<Selection>, Choice> {
  const here = (): Location => ({ url: browser.url(), fresh: browser.newConversation() });

  const location = Atom.keepAlive(
    Atom.writable<Location, Navigation>(
      (get) => {
        get.addFinalizer(browser.onPop(() => get.setSelf(here())));

        return here();
      },
      (ctx, { url, history }) => {
        browser[history](url);
        ctx.setSelf({ url, fresh: browser.newConversation() });
      },
    ),
  );

  // The source of truth for each Bot's last conversation; storage only mirrors it, so a private window
  // still returns to the conversation a person left.
  const memory: Atom.Writable<Memory, Selection> = Atom.keepAlive(
    Atom.writable(
      () => readMemory(browser.storage),
      (ctx, selection: Selection) =>
        ctx.setSelf(remember(browser.storage, ctx.get(memory), selection)),
    ),
  );

  const selection: Atom.Writable<Option.Option<Selection>, Choice> = Atom.keepAlive(
    Atom.writable(
      (get) =>
        Option.map(get(bots), (list) => {
          const { url, fresh } = get(location);
          const remembered = get(memory);
          const requested = resolveSelection(url, list, remembered, fresh);

          const outcome = AsyncResult.value(
            get(open({ conversationId: requested.conversation, botId: requested.bot })),
          );

          const shown = follow(requested, outcome, fresh);
          const showing = withSelection(url, shown);

          // Each write changes what this read depends on, so it runs again and finds nothing to write.
          if (showing.href !== url.href) get.set(location, { url: showing, history: "replace" });

          if (
            Option.exists(outcome, OpenOutcome.$is("Opened")) &&
            remembered.get(shown.bot) !== shown.conversation
          ) {
            get.set(memory, shown);
          }

          return shown;
        }),
      (ctx, choice: Choice) => {
        const next = Option.flatMap(ctx.get(selection), (current) =>
          choose(current, choice, ctx.get(memory), browser.newConversation()),
        );

        if (Option.isNone(next)) return;

        ctx.set(location, {
          url: withSelection(ctx.get(location).url, next.value),
          history: "push",
        });
      },
    ),
  );

  return selection;
}

/** The page's own browser. */
const pageBrowser: Browser = {
  ...pageHistory,
  replace: (url) => window.history.replaceState(null, "", url),
  storage: () => window.localStorage,
  newConversation: () => ConversationId.make(crypto.randomUUID()),
};

/** The page's selection, over its own URL and storage. */
export const selection = makeSelection(
  pageBrowser,
  Atom.map(botList, AsyncResult.value),
  conversation.open,
);

/**
Forgets each Bot's last conversation on this browser, so whoever signs in next on it does not open the
last person's.
*/
export const forgetPageMemory = () => forgetMemory(pageBrowser.storage);
