import { afterEach, describe, expect, it } from "vite-plus/test";
import { BotId, ChatRpcs, ConversationBusy, ConversationId, MessageId, RunId } from "@aobot/domain";
import type { ChatEvent } from "@aobot/domain";
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
  readonly send: (stopped: Deferred.Deferred<void>) => Stream.Stream<ChatEvent, ConversationBusy>;
}) => {
  const stopped = Deferred.makeUnsafe<void>();

  const handlers = ChatRpcs.toLayer({
    "Chat.open": () => Effect.succeed({ bot, messages: [], isRunning: false }),
    "Chat.send": () => script.send(stopped),
    "Chat.stop": () => Deferred.succeed(stopped, undefined).pipe(Effect.asVoid),
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
  const atoms = makeConversations(fakeServer(script))(conversationId);

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

const userMessage = { messageId: MessageId.make("u1"), text: "Say hi in five words" };

describe("given a conversation served by an in-memory Bot", () => {
  it("loads the stored Bot before anything is sent", async () => {
    const { registry, atoms } = start({ send: () => Stream.empty });
    const state = await until(registry, atoms.state, (current) => Option.isSome(current.bot));

    expect(isRunning(state)).toBe(false);
  });

  describe("when the person sends a message and the Bot is still talking", () => {
    it("shows their message and the Bot's words so far, and is running", async () => {
      const { registry, atoms } = start({
        send: () => Stream.concat(Stream.fromIterable(started), Stream.never),
      });

      await until(registry, atoms.state, (current) => Option.isSome(current.bot));
      registry.set(atoms.send, userMessage);

      const state = await until(registry, atoms.state, (current) => current.messages.length === 2);

      expect(state.messages.map((message) => message.text)).toEqual([userMessage.text, "Hello"]);
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
      await until(registry, atoms.state, (current) => current.messages.length === 2);
      registry.set(atoms.stop, undefined);

      const state = await until(registry, atoms.state, (current) => !isRunning(current));

      expect(ConversationStatus.$is("Idle")(state.status)).toBe(true);
      expect(state.messages.at(-1)?.text).toBe("Hello");
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
      (current) => current.messages.length === 2 && !isRunning(current),
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
    expect(state.messages).toEqual([]);
  });
});
