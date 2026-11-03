import { BotId, type BotSummary, ConversationId, type OpenConversation } from "@aobot/domain";
import { type Array, Option } from "effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { OpenOutcome } from "../features/chat/public.ts";
import {
  botLink,
  Choice,
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
import { type Browser, makeSelection } from "./selection-atoms.ts";

function bot(id: string): BotSummary {
  return { id: BotId.make(id), name: id, group: Option.none(), pinned: false };
}

const bots = [bot("assistant"), bot("researcher")] as const;

const assistant = BotId.make("assistant");

const researcher = BotId.make("researcher");

const researchers = ConversationId.make("researchers-last");

const memory: Memory = new Map([[researcher, researchers]]);

const fresh = ConversationId.make("fresh");

function opening(query: string) {
  return resolveSelection(new URL(`http://localhost:3100/${query}`), bots, memory, fresh);
}

describe("resolveSelection", () => {
  it.each([
    ["nothing", "", "assistant", "fresh"],
    ["a Bot", "?bot=researcher", "researcher", "researchers-last"],
    ["a Bot and its conversation", "?bot=researcher&c=c1", "researcher", "c1"],
    ["only a conversation, as links did before Bots were picked", "?c=c1", "assistant", "c1"],
    ["a Bot the server does not know", "?bot=ghost&c=c1", "assistant", "fresh"],
    ["a Bot id that is not one", "?bot=Not%20A%20Bot", "assistant", "fresh"],
    [
      "a Bot's name instead of its id, with a conversation",
      "?bot=Researcher&c=c1",
      "assistant",
      "fresh",
    ],
    ["an empty Bot, with a conversation", "?bot=&c=c1", "assistant", "fresh"],
    ["an empty conversation", "?bot=researcher&c=", "researcher", "researchers-last"],
  ])("opens on a URL naming %s", (_what, query, expectedBot, expectedConversation) => {
    expect(opening(query)).toEqual({ bot: expectedBot, conversation: expectedConversation });
  });
});

describe("withSelection and botLink", () => {
  it("write the Bot and the conversation into the URL, keeping the rest", () => {
    const url = new URL("http://localhost:3100/?debug=1&c=old");

    expect(
      withSelection(url, { bot: researcher, conversation: ConversationId.make("c2") }).search,
    ).toBe("?debug=1&c=c2&bot=researcher");
    expect(botLink(url, researcher).search).toBe("?debug=1&bot=researcher");
  });
});

describe("follow", () => {
  const requested: Selection = { bot: assistant, conversation: ConversationId.make("c1") };

  it.each([
    ["no answer yet", Option.none(), requested],
    ["opened", Option.some(OpenOutcome.Opened({ bot: bots[0] })), requested],
    [
      "a Bot the server does not know",
      Option.some(OpenOutcome.UnknownBot({ botId: assistant })),
      requested,
    ],
    [
      "a conversation of another Bot",
      Option.some(OpenOutcome.OfAnotherBot({ botId: researcher })),
      { bot: researcher, conversation: "c1" },
    ],
    [
      "a conversation that is not the person's",
      Option.some(OpenOutcome.NotYours({ conversation: ConversationId.make("own") })),
      { bot: assistant, conversation: "own" },
    ],
  ])("shows, on %s, the conversation with its own Bot", (_what, outcome, expected) => {
    expect(follow(requested, outcome)).toEqual(expected);
  });
});

describe("choose", () => {
  const current: Selection = { bot: assistant, conversation: ConversationId.make("a1") };
  const listed: Selection = { bot: researcher, conversation: ConversationId.make("r2") };

  it.each([
    ["the Bot open already", Choice.Bot({ bot: assistant }), Option.none()],
    [
      "another Bot, on its last conversation",
      Choice.Bot({ bot: researcher }),
      Option.some({ bot: researcher, conversation: researchers }),
    ],
    ["the conversation open already", Choice.Conversation({ selection: current }), Option.none()],
    ["another conversation", Choice.Conversation({ selection: listed }), Option.some(listed)],
    [
      "a new conversation",
      Choice.New({ bot: assistant }),
      Option.some({ bot: assistant, conversation: fresh }),
    ],
  ])("opens, for %s, what it names", (_what, choice, expected) => {
    expect(choose(current, choice, memory, fresh)).toEqual(expected);
  });
});

/** Storage that works, shared by every tab given it, as a browser's `localStorage` is. */
function sharedStorage(): MemoryStorage {
  const stored = new Map<string, string>();

  return () => ({
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => void stored.set(key, value),
    removeItem: (key) => void stored.delete(key),
  });
}

/** Storage that refuses, as a private window's can. */
const refusing: MemoryStorage = () => {
  throw new Error("SecurityError");
};

describe("readMemory and remember", () => {
  it("mirror the last conversation per Bot into storage", () => {
    const storage = sharedStorage();

    remember(storage, new Map([[researcher, researchers]]), {
      bot: assistant,
      conversation: ConversationId.make("a2"),
    });

    expect(readMemory(storage)).toEqual(
      new Map([
        [researcher, researchers],
        [assistant, "a2"],
      ]),
    );
  });

  it("keep what another tab stored since, so neither overwrites the other's Bots", () => {
    const storage = sharedStorage();
    const before = readMemory(storage);

    remember(storage, before, { bot: assistant, conversation: ConversationId.make("a1") });
    remember(storage, before, { bot: researcher, conversation: ConversationId.make("r1") });

    expect(readMemory(storage)).toEqual(
      new Map([
        [assistant, "a1"],
        [researcher, "r1"],
      ]),
    );
  });

  it("read nothing, and do not fail, where storage refuses or holds something else", () => {
    expect(remember(refusing, memory, { bot: assistant, conversation: fresh }).get(assistant)).toBe(
      fresh,
    );
    expect(readMemory(refusing).size).toBe(0);
    expect(
      readMemory(() => ({
        getItem: () => "{not json",
        setItem: () => undefined,
        removeItem: () => undefined,
      })).size,
    ).toBe(0);
    expect(
      readMemory(() => ({
        getItem: () => '{"Not A Bot":"c1"}',
        setItem: () => undefined,
        removeItem: () => undefined,
      })).size,
    ).toBe(0);
  });

  it("leave nothing for the next person once the page forgot them, as it does on sign-out", () => {
    const storage = sharedStorage();
    remember(storage, new Map(), { bot: assistant, conversation: ConversationId.make("a1") });

    forgetMemory(storage);

    expect(readMemory(storage)).toEqual(new Map());
    expect(() => forgetMemory(refusing)).not.toThrow();
  });
});

/** A browser whose history is a list and whose ids count up. Its storage refuses unless one is given. */
function fakeBrowser(start: string, storage: MemoryStorage) {
  const entries = [new URL(start)];
  let at = 0;
  let made = 0;
  const listeners = new Set<() => void>();

  const browser: Browser = {
    url: () => entries[at] ?? new URL(start),
    push: (url) => {
      entries.splice(at + 1, entries.length, url);
      at = entries.length - 1;
    },
    replace: (url) => {
      entries[at] = url;
    },
    onPop: (f) => {
      listeners.add(f);

      return () => listeners.delete(f);
    },
    storage,
    newConversation: () => ConversationId.make(`new-${++made}`),
  };

  const back = () => {
    at -= 1;
    listeners.forEach((f) => f());
  };

  return { browser, back, entries: () => entries.map((url) => url.search) };
}

const registries: AtomRegistry.AtomRegistry[] = [];

afterEach(() => {
  registries.splice(0).forEach((registry) => registry.dispose());
});

type Answer = AsyncResult.AsyncResult<OpenOutcome, never>;

/**
A server that answers each open as the test says, once it says: by default it opens a conversation with
any Bot it lists. It counts every open the page asks for.
*/
function fakeServer(listed: Array.NonEmptyReadonlyArray<BotSummary>) {
  const opens: Array<typeof OpenConversation.Type> = [];

  const open = Atom.family((opening: typeof OpenConversation.Type) =>
    Atom.writable<Answer, Answer>(
      () => {
        opens.push(opening);

        return AsyncResult.initial();
      },
      (ctx, answer) => ctx.setSelf(answer),
    ),
  );

  const answer = (
    registry: AtomRegistry.AtomRegistry,
    selection: Selection,
    outcome: OpenOutcome,
  ) =>
    registry.set(
      open({ conversationId: selection.conversation, botId: selection.bot }),
      AsyncResult.success(outcome),
    );

  const opened = (registry: AtomRegistry.AtomRegistry, selection: Selection) => {
    const known = listed.find((listedBot) => listedBot.id === selection.bot);

    answer(
      registry,
      selection,
      known === undefined
        ? OpenOutcome.UnknownBot({ botId: selection.bot })
        : OpenOutcome.Opened({ bot: known }),
    );
  };

  return { open, opens, answer, opened };
}

function page(start: string, options?: { readonly storage?: MemoryStorage }) {
  const fake = fakeBrowser(start, options?.storage ?? refusing);
  const registry = AtomRegistry.make();
  registries.push(registry);

  const list = Atom.make<Option.Option<Array.NonEmptyReadonlyArray<BotSummary>>>(Option.some(bots));
  const server = fakeServer(bots);
  const selection = makeSelection(fake.browser, list, server.open);
  registry.mount(selection);

  const now = () => Option.getOrThrow(registry.get(selection));
  const pick = (next: BotId) => registry.set(selection, Choice.Bot({ bot: next }));
  const chooseNext = (choice: Choice) => registry.set(selection, choice);
  const confirm = () => server.opened(registry, now());

  const answer = (outcome: OpenOutcome, selection = now()) =>
    server.answer(registry, selection, outcome);

  const listBots = (listed: Array.NonEmptyReadonlyArray<BotSummary>) =>
    registry.set(list, Option.some(listed));

  return { ...fake, now, pick, chooseNext, confirm, answer, listBots, opens: server.opens };
}

describe("the selection", () => {
  it("writes what it opened into the URL without a history entry", () => {
    const tab = page("http://localhost:3100/");

    expect(tab.now()).toEqual({ bot: "assistant", conversation: "new-1" });
    expect(tab.entries()).toEqual(["?bot=assistant&c=new-1"]);
  });

  it("pushes each pick, so Back returns to the Bot before", () => {
    const tab = page("http://localhost:3100/?bot=assistant&c=a1");

    tab.pick(researcher);
    expect(tab.now().bot).toBe("researcher");

    tab.back();
    expect(tab.now()).toEqual({ bot: "assistant", conversation: "a1" });
  });

  it("returns to the conversation a Bot had open once the server confirmed it, even without storage", () => {
    const tab = page("http://localhost:3100/?bot=assistant&c=a1");

    tab.pick(researcher);
    const researchersFirst = tab.now();
    tab.confirm();
    tab.pick(assistant);
    tab.pick(researcher);

    expect(tab.now()).toEqual(researchersFirst);
  });

  it("does not remember a conversation the server never confirmed", () => {
    const tab = page("http://localhost:3100/?bot=assistant&c=a1");

    tab.pick(researcher);
    const unconfirmed = tab.now();
    tab.pick(assistant);
    tab.pick(researcher);

    expect(tab.now()).not.toEqual(unconfirmed);
  });

  it("keeps what each tab remembers when two tabs share storage", () => {
    const storage = sharedStorage();
    const first = page("http://localhost:3100/?bot=assistant&c=a1", { storage });
    const second = page("http://localhost:3100/?bot=researcher&c=r1", { storage });

    first.confirm();
    second.confirm();

    expect(readMemory(storage)).toEqual(
      new Map([
        [assistant, "a1"],
        [researcher, "r1"],
      ]),
    );
  });

  it("follows a conversation to the Bot it belongs to, in place of the URL it was opened on", () => {
    const tab = page("http://localhost:3100/?bot=assistant&c=r1");

    tab.answer(OpenOutcome.OfAnotherBot({ botId: researcher }));

    expect(tab.now()).toEqual({ bot: "researcher", conversation: "r1" });
    expect(tab.entries()).toEqual(["?bot=researcher&c=r1"]);
  });

  it("stays on a Bot the server does not know until a fresh Bot list leaves it out", () => {
    const tab = page("http://localhost:3100/?bot=researcher&c=r1");

    tab.answer(OpenOutcome.UnknownBot({ botId: researcher }));
    expect(tab.now()).toEqual({ bot: "researcher", conversation: "r1" });

    tab.listBots([bots[0]]);
    expect(tab.now().bot).toBe("assistant");
    expect(tab.now().conversation).toMatch(/^new-/u);
    expect(tab.entries()).toEqual([`?bot=assistant&c=${tab.now().conversation}`]);
  });

  it("never hops between Bots the server does not know, opening each once", () => {
    const tab = page("http://localhost:3100/?bot=assistant&c=a1");

    tab.answer(OpenOutcome.UnknownBot({ botId: assistant }));
    tab.listBots(bots);

    expect(tab.now()).toEqual({ bot: "assistant", conversation: "a1" });
    expect(tab.opens).toEqual([{ conversationId: "a1", botId: "assistant" }]);
  });

  it("leaves a conversation that is not the person's for a new one, and remembers that one instead", () => {
    const storage = sharedStorage();
    remember(storage, new Map(), { bot: assistant, conversation: ConversationId.make("theirs") });
    const tab = page("http://localhost:3100/?bot=assistant", { storage });

    expect(tab.now().conversation).toBe("theirs");

    tab.answer(OpenOutcome.NotYours({ conversation: ConversationId.make("own") }));
    const own = tab.now();
    tab.confirm();

    expect(own).toEqual({ bot: "assistant", conversation: "own" });
    expect(tab.entries()).toEqual([`?bot=assistant&c=${own.conversation}`]);
    expect(readMemory(storage).get(assistant)).toBe(own.conversation);
  });

  it("opens a listed conversation and a new one, each with a history entry", () => {
    const tab = page("http://localhost:3100/?bot=assistant&c=a1");

    tab.chooseNext(
      Choice.Conversation({
        selection: { bot: researcher, conversation: ConversationId.make("r2") },
      }),
    );
    expect(tab.now()).toEqual({ bot: "researcher", conversation: "r2" });

    tab.chooseNext(Choice.New({ bot: researcher }));
    expect(tab.now()).toEqual({ bot: "researcher", conversation: expect.stringMatching(/^new-/u) });

    tab.back();
    expect(tab.now()).toEqual({ bot: "researcher", conversation: "r2" });
  });

  it("ignores an answer about a selection the person already left", () => {
    const tab = page("http://localhost:3100/?bot=assistant&c=a1");
    const left = tab.now();

    tab.pick(researcher);
    tab.answer(OpenOutcome.OfAnotherBot({ botId: researcher }), left);

    expect(tab.now().conversation).not.toBe("a1");
  });
});
