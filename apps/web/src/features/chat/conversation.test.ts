import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  BotId,
  ChatRpcs,
  ConversationBusy,
  ConversationId,
  ConversationOfAnotherBot,
  MessageAlreadySent,
  MessageId,
  RunId,
  UnknownBot,
} from "@aobot/domain";
import type { ChatEvent, ConversationSnapshot } from "@aobot/domain";
import { Deferred, Effect, Layer, Option, Stream } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import { RpcTest } from "effect/rpc";
import { ChatClient } from "./chat-client.ts";
import { makeConversations } from "./conversation.ts";
import {
  ConversationStatus,
  OpenOutcome,
  TranscriptItem,
  isRunning,
} from "./conversation-state.ts";
import type { ConversationState } from "./conversation-state.ts";

const conversationId = ConversationId.make("c1");

const runId = RunId.make("r1");

const botMessage = MessageId.make("b1");

const bot = { id: BotId.make("bot"), name: "Chief", group: Option.none(), pinned: false };

const started: ChatEvent[] = [
  { type: "RUN_STARTED", threadId: conversationId, runId },
  { type: "TEXT_MESSAGE_START", messageId: botMessage, role: "assistant" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: botMessage, delta: "Hello" },
];

const fakeServer = (script: {
  readonly send: (
    stopped: Deferred.Deferred<void>,
  ) => Stream.Stream<ChatEvent, ConversationBusy | MessageAlreadySent | ConversationOfAnotherBot>;
  readonly open?: Effect.Effect<ConversationSnapshot, UnknownBot | ConversationOfAnotherBot>;
  readonly stop?: (stopped: Deferred.Deferred<void>) => Effect.Effect<void>;
}) => {
  const stopped = Deferred.makeUnsafe<void>();

  const handlers = ChatRpcs.toLayer({
    "Chat.open": () => script.open ?? Effect.succeed({ bot, messages: [], isRunning: false }),
    "Chat.send": () => script.send(stopped),
    "Chat.stop": () =>
      script.stop?.(stopped) ?? Deferred.succeed(stopped, undefined).pipe(Effect.asVoid),
  });

  return Atom.runtime(
    Layer.effect(ChatClient, RpcTest.makeClient(ChatRpcs, { flatten: true })).pipe(
      Layer.provide(handlers),
    ),
  );
};

const texts = (state: ConversationState) =>
  state.transcript.flatMap((item) => (TranscriptItem.$is("Message")(item) ? [item.text] : []));

const registries: AtomRegistry.AtomRegistry[] = [];

function start(script: Parameters<typeof fakeServer>[0]) {
  const registry = AtomRegistry.make();
  let botListAsked = 0;

  const botList = Atom.make(() => {
    botListAsked += 1;

    return botListAsked;
  });

  const conversations = makeConversations(fakeServer(script), botList, "10 millis");

  const atoms = {
    state: conversations.state(conversationId),
    open: conversations.open({ conversationId, botId: bot.id }),
    send: conversations.send(conversationId),
    stop: conversations.stop(conversationId),
  };

  registries.push(registry);
  registry.mount(botList);
  registry.mount(atoms.open);
  registry.mount(atoms.send);
  registry.mount(atoms.stop);

  return { registry, atoms, botListAsked: () => botListAsked };
}

/** What the server answered once the open settled. */
function opened(
  registry: AtomRegistry.AtomRegistry,
  atom: ReturnType<ReturnType<typeof makeConversations>["open"]>,
): Promise<OpenOutcome> {
  return Atom.getResult(atom).pipe(
    Effect.provideService(AtomRegistry.AtomRegistry, registry),
    Effect.runPromise,
  );
}

function until(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<ConversationState>,
  predicate: (state: ConversationState) => boolean,
): Promise<ConversationState> {
  return Atom.toStream(atom).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.provideService(AtomRegistry.AtomRegistry, registry),
    Effect.runPromise,
  );
}

afterEach(() => {
  registries.splice(0).forEach((registry) => registry.dispose());
});

const userMessage = {
  botId: bot.id,
  messageId: MessageId.make("u1"),
  text: "Say hi in five words",
};

describe("given a conversation served by an in-memory Bot", () => {
  it("loads the stored Bot before anything is sent", async () => {
    const { registry, atoms } = start({ send: () => Stream.empty });
    const state = await until(registry, atoms.state, (current) => Option.isSome(current.bot));

    expect(isRunning(state)).toBe(false);
  });

  it("says when the server knows no such Bot, asking for the Bot list once more and not again", async () => {
    let asked = 0;

    const { registry, atoms, botListAsked } = start({
      send: () => Stream.empty,
      open: Effect.suspend(() => {
        asked += 1;

        return Effect.fail(new UnknownBot({ botId: bot.id }));
      }),
    });

    const outcome = await opened(registry, atoms.open);
    const state = registry.get(atoms.state);

    expect(outcome).toEqual(OpenOutcome.UnknownBot({ botId: bot.id }));
    expect(state.status).toEqual(
      ConversationStatus.Failed({
        code: "unknown_bot",
        message: "The server knows no Bot called bot. Pick one in the sidebar.",
      }),
    );
    expect(asked).toBe(1);
    expect(botListAsked()).toBe(2);
  });

  it("answers that the conversation belongs to another Bot, leaving the state as it was", async () => {
    const { registry, atoms } = start({
      send: () => Stream.empty,
      open: Effect.fail(
        new ConversationOfAnotherBot({ conversationId, botId: BotId.make("other") }),
      ),
    });

    expect(await opened(registry, atoms.open)).toEqual(
      OpenOutcome.OfAnotherBot({ botId: BotId.make("other") }),
    );
    expect(registry.get(atoms.state).bot).toEqual(Option.none());
  });

  it("takes a message back to offer it again and opens again when the conversation turned out another Bot's", async () => {
    const askedAgain = Deferred.makeUnsafe<void>();
    let asked = 0;

    const { registry, atoms } = start({
      send: () =>
        Stream.fail(new ConversationOfAnotherBot({ conversationId, botId: BotId.make("other") })),
      open: Effect.suspend(() => {
        asked += 1;

        return Effect.as(asked === 2 ? Deferred.succeed(askedAgain, undefined) : Effect.void, {
          bot,
          messages: [],
          isRunning: false,
        });
      }),
    });

    await opened(registry, atoms.open);
    registry.set(atoms.send, userMessage);
    await Effect.runPromise(Deferred.await(askedAgain));

    expect(texts(registry.get(atoms.state))).toEqual([]);
    expect(registry.get(atoms.state).unsent).toEqual(
      Option.some({ id: userMessage.messageId, text: userMessage.text }),
    );
  });

  describe("when the person presses stop before the server has started the run", () => {
    it("holds the stop until the run starts, so the Bot says nothing", async () => {
      const pickedUp = Deferred.makeUnsafe<void>();
      const runStarted = Deferred.makeUnsafe<void>();

      const { registry, atoms } = start({
        send: (stopped) =>
          Stream.unwrap(
            Deferred.await(pickedUp).pipe(
              Effect.andThen(Deferred.succeed(runStarted, undefined)),
              Effect.as(
                Stream.concat(
                  Stream.fromIterable<ChatEvent>([
                    { type: "RUN_STARTED", threadId: conversationId, runId },
                  ]),
                  Stream.unwrap(
                    Effect.raceFirst(
                      Deferred.await(stopped).pipe(
                        Effect.as(
                          Stream.fromIterable<ChatEvent>([
                            { type: "RUN_ERROR", message: "Stopped.", code: "stopped" },
                          ]),
                        ),
                      ),
                      Effect.sleep("100 millis").pipe(
                        Effect.as(
                          Stream.fromIterable<ChatEvent>([
                            ...started.slice(1),
                            { type: "TEXT_MESSAGE_END", messageId: botMessage },
                            { type: "RUN_FINISHED", threadId: conversationId, runId },
                          ]),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        stop: (stopped) =>
          Deferred.isDone(runStarted).pipe(
            Effect.flatMap((isStarted) =>
              isStarted ? Deferred.succeed(stopped, undefined) : Effect.succeed(false),
            ),
            Effect.asVoid,
          ),
      });

      await until(registry, atoms.state, (current) => Option.isSome(current.bot));
      registry.set(atoms.send, userMessage);
      registry.set(atoms.stop, undefined);
      Deferred.doneUnsafe(pickedUp, Effect.void);

      const state = await until(registry, atoms.state, (current) => !isRunning(current));

      expect(texts(state)).toEqual([userMessage.text]);
      expect(ConversationStatus.$is("Idle")(state.status)).toBe(true);
    });
  });

  describe("when the person sends a message and the Bot is still talking", () => {
    it("shows their message and the Bot's words so far, and is running", async () => {
      const { registry, atoms } = start({
        send: () => Stream.concat(Stream.fromIterable(started), Stream.never),
      });

      await until(registry, atoms.state, (current) => Option.isSome(current.bot));
      registry.set(atoms.send, userMessage);

      const state = await until(
        registry,
        atoms.state,
        (current) => current.transcript.length === 2,
      );

      expect(texts(state)).toEqual([userMessage.text, "Hello"]);
      expect(isRunning(state)).toBe(true);
    });

    it("ends the run when the person stops it", async () => {
      const { registry, atoms } = start({
        send: (stopped) =>
          Stream.concat(
            Stream.fromIterable(started),
            Stream.fromEffect(
              Deferred.await(stopped).pipe(
                Effect.as<ChatEvent>({ type: "RUN_ERROR", message: "stopped", code: "stopped" }),
              ),
            ),
          ),
      });

      await until(registry, atoms.state, (current) => Option.isSome(current.bot));
      registry.set(atoms.send, userMessage);
      await until(registry, atoms.state, (current) => current.transcript.length === 2);
      registry.set(atoms.stop, undefined);

      const state = await until(registry, atoms.state, (current) => !isRunning(current));

      expect(ConversationStatus.$is("Idle")(state.status)).toBe(true);
      expect(texts(state).at(-1)).toBe("Hello");
    });
  });

  it("finishes the run when the Bot's last word arrives", async () => {
    const { registry, atoms } = start({
      send: () =>
        Stream.fromIterable<ChatEvent>([
          ...started,
          { type: "RUN_FINISHED", threadId: conversationId, runId },
        ]),
    });

    await until(registry, atoms.state, (current) => Option.isSome(current.bot));
    registry.set(atoms.send, userMessage);

    const state = await until(
      registry,
      atoms.state,
      (current) => current.transcript.length === 2 && !isRunning(current),
    );

    expect(ConversationStatus.$is("Idle")(state.status)).toBe(true);
  });

  it("shows a readable busy state and drops the refused message", async () => {
    const { registry, atoms } = start({
      send: () => Stream.fail(new ConversationBusy({ conversationId })),
    });

    await until(registry, atoms.state, (current) => Option.isSome(current.bot));
    registry.set(atoms.send, userMessage);

    const state = await until(registry, atoms.state, (current) =>
      ConversationStatus.$is("Failed")(current.status),
    );

    expect(state.status).toMatchObject({ code: "busy" });
    expect(state.transcript).toEqual([]);
  });

  it("goes idle and keeps one bubble when the server says it already had the message", async () => {
    const { registry, atoms } = start({
      send: () => Stream.fail(new MessageAlreadySent({ messageId: userMessage.messageId })),
    });

    await until(registry, atoms.state, (current) => Option.isSome(current.bot));
    registry.set(atoms.send, userMessage);

    const state = await until(
      registry,
      atoms.state,
      (current) => current.transcript.length === 1 && !isRunning(current),
    );

    expect(ConversationStatus.$is("Idle")(state.status)).toBe(true);
  });
});

describe("given a server that crashes while opening the conversation once", () => {
  it("reports it, then reconnects and loads the Bot", async () => {
    const reconnect = Deferred.makeUnsafe<void>();
    let opens = 0;

    const { registry, atoms } = start({
      send: () => Stream.empty,
      open: Effect.suspend(() =>
        opens++ === 0
          ? Effect.die("database is locked")
          : Deferred.await(reconnect).pipe(Effect.as({ bot, messages: [], isRunning: false })),
      ),
    });

    const failed = await until(registry, atoms.state, (current) =>
      ConversationStatus.$is("Failed")(current.status),
    );

    expect(failed.status).toMatchObject({ code: "connection" });
    expect(Option.isNone(failed.bot)).toBe(true);

    Deferred.doneUnsafe(reconnect, Effect.void);

    const recovered = await until(registry, atoms.state, (current) => Option.isSome(current.bot));

    expect(ConversationStatus.$is("Idle")(recovered.status)).toBe(true);
  });
});
