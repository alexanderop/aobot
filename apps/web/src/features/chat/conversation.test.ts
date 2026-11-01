import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  BotId,
  ChatRpcs,
  ConversationBusy,
  ConversationId,
  MessageAlreadySent,
  MessageId,
  RunId,
} from "@aobot/domain";
import type { ChatEvent, ConversationSnapshot } from "@aobot/domain";
import { Deferred, Effect, Layer, Option, Stream } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import { RpcTest } from "effect/rpc";
import { ChatClient } from "./chat-client.ts";
import { makeConversations } from "./conversation.ts";
import { ConversationStatus, isRunning } from "./conversation-state.ts";
import type { ConversationState } from "./conversation-state.ts";

const conversationId = ConversationId.make("c1");

const runId = RunId.make("r1");

const botMessage = MessageId.make("b1");

const bot = { id: BotId.make("bot"), name: "Chief" };

const started: ChatEvent[] = [
  { type: "RUN_STARTED", threadId: conversationId, runId },
  { type: "TEXT_MESSAGE_START", messageId: botMessage, role: "assistant" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: botMessage, delta: "Hello" },
];

const fakeServer = (script: {
  readonly send: (
    stopped: Deferred.Deferred<void>,
  ) => Stream.Stream<ChatEvent, ConversationBusy | MessageAlreadySent>;
  readonly open?: Effect.Effect<ConversationSnapshot>;
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

const registries: AtomRegistry.AtomRegistry[] = [];

function start(script: Parameters<typeof fakeServer>[0]) {
  const registry = AtomRegistry.make();

  const conversations = makeConversations(fakeServer(script), "10 millis");

  const atoms = {
    state: conversations.state(conversationId),
    open: conversations.open(conversationId),
    send: conversations.send(conversationId),
    stop: conversations.stop(conversationId),
  };

  registries.push(registry);
  registry.mount(atoms.open);
  registry.mount(atoms.send);
  registry.mount(atoms.stop);

  return { registry, atoms };
}

function until(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<ConversationState>,
  predicate: (state: ConversationState) => boolean,
): Effect.Effect<ConversationState> {
  return Atom.toStream(atom).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.provideService(AtomRegistry.AtomRegistry, registry),
  );
}

afterEach(() => {
  registries.splice(0).forEach((registry) => registry.dispose());
});

const userMessage = { messageId: MessageId.make("u1"), text: "Say hi in five words" };

describe("given a conversation served by an in-memory Bot", () => {
  it.live("loads the stored Bot before anything is sent", () =>
    Effect.gen(function* () {
      const { registry, atoms } = start({ send: () => Stream.empty });
      const state = yield* until(registry, atoms.state, (current) => Option.isSome(current.bot));

      expect(isRunning(state)).toBe(false);
    }),
  );

  describe("when the person presses stop before the server has started the run", () => {
    it.live("holds the stop until the run starts, so the Bot says nothing", () =>
      Effect.gen(function* () {
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

        yield* until(registry, atoms.state, (current) => Option.isSome(current.bot));
        registry.set(atoms.send, userMessage);
        registry.set(atoms.stop, undefined);
        Deferred.doneUnsafe(pickedUp, Effect.void);

        const state = yield* until(registry, atoms.state, (current) => !isRunning(current));

        expect(state.messages.map((message) => message.text)).toEqual([userMessage.text]);
        expect(ConversationStatus.$is("Idle")(state.status)).toBe(true);
      }),
    );
  });

  describe("when the person sends a message and the Bot is still talking", () => {
    it.live("shows their message and the Bot's words so far, and is running", () =>
      Effect.gen(function* () {
        const { registry, atoms } = start({
          send: () => Stream.concat(Stream.fromIterable(started), Stream.never),
        });

        yield* until(registry, atoms.state, (current) => Option.isSome(current.bot));
        registry.set(atoms.send, userMessage);

        const state = yield* until(
          registry,
          atoms.state,
          (current) => current.messages.length === 2,
        );

        expect(state.messages.map((message) => message.text)).toEqual([userMessage.text, "Hello"]);
        expect(isRunning(state)).toBe(true);
      }),
    );

    it.live("ends the run when the person stops it", () =>
      Effect.gen(function* () {
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

        yield* until(registry, atoms.state, (current) => Option.isSome(current.bot));
        registry.set(atoms.send, userMessage);
        yield* until(registry, atoms.state, (current) => current.messages.length === 2);
        registry.set(atoms.stop, undefined);

        const state = yield* until(registry, atoms.state, (current) => !isRunning(current));

        expect(ConversationStatus.$is("Idle")(state.status)).toBe(true);
        expect(state.messages.at(-1)?.text).toBe("Hello");
      }),
    );
  });

  it.live("finishes the run when the Bot's last word arrives", () =>
    Effect.gen(function* () {
      const { registry, atoms } = start({
        send: () =>
          Stream.fromIterable<ChatEvent>([
            ...started,
            { type: "RUN_FINISHED", threadId: conversationId, runId },
          ]),
      });

      yield* until(registry, atoms.state, (current) => Option.isSome(current.bot));
      registry.set(atoms.send, userMessage);

      const state = yield* until(
        registry,
        atoms.state,
        (current) => current.messages.length === 2 && !isRunning(current),
      );

      expect(ConversationStatus.$is("Idle")(state.status)).toBe(true);
    }),
  );

  it.live("shows a readable busy state and drops the refused message", () =>
    Effect.gen(function* () {
      const { registry, atoms } = start({
        send: () => Stream.fail(new ConversationBusy({ conversationId })),
      });

      yield* until(registry, atoms.state, (current) => Option.isSome(current.bot));
      registry.set(atoms.send, userMessage);

      const state = yield* until(registry, atoms.state, (current) =>
        ConversationStatus.$is("Failed")(current.status),
      );

      expect(state.status).toMatchObject({ code: "busy" });
      expect(state.messages).toEqual([]);
    }),
  );

  it.live("goes idle and keeps one bubble when the server says it already had the message", () =>
    Effect.gen(function* () {
      const { registry, atoms } = start({
        send: () => Stream.fail(new MessageAlreadySent({ messageId: userMessage.messageId })),
      });

      yield* until(registry, atoms.state, (current) => Option.isSome(current.bot));
      registry.set(atoms.send, userMessage);

      const state = yield* until(
        registry,
        atoms.state,
        (current) => current.messages.length === 1 && !isRunning(current),
      );

      expect(ConversationStatus.$is("Idle")(state.status)).toBe(true);
    }),
  );
});

describe("given a server that crashes while opening the conversation once", () => {
  it.live("reports it, then reconnects and loads the Bot", () =>
    Effect.gen(function* () {
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

      const failed = yield* until(registry, atoms.state, (current) =>
        ConversationStatus.$is("Failed")(current.status),
      );

      expect(failed.status).toMatchObject({ code: "connection" });
      expect(Option.isNone(failed.bot)).toBe(true);

      Deferred.doneUnsafe(reconnect, Effect.void);

      const recovered = yield* until(registry, atoms.state, (current) =>
        Option.isSome(current.bot),
      );

      expect(ConversationStatus.$is("Idle")(recovered.status)).toBe(true);
    }),
  );
});
