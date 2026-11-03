import {
  BotId,
  type ChatEvent,
  ChatRpcs,
  ConversationBusy,
  ConversationId,
  MessageAlreadySent,
  MessageId,
  ToolCallId,
  UnknownBot,
  ConversationOfAnotherBot,
} from "@aobot/domain";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Queue, Stream } from "effect";
import { RpcTest } from "effect/rpc";
import { SqlClient } from "effect/sql";
import { AgentEvent, type AgentError, AgentRuntime, Stalled, type Turn } from "../agent/public.ts";
import { ConversationStore, conversationStoreLayer } from "./conversation-store.ts";
import { chatHandlersLayer } from "./handlers.ts";
import { chatLayer } from "./public.ts";
import { assistant, researcher } from "../bots/testing/test-bots.ts";
import { testServer } from "./testing/test-server.ts";

const conversationId = ConversationId.make("conversation-1");

const opening = { conversationId, botId: assistant.id };

function chatWith(answer: Stream.Stream<AgentEvent, AgentError>) {
  const agent = Layer.succeed(AgentRuntime, AgentRuntime.of({ run: () => answer }));

  return chatLayer.pipe(Layer.provide(agent), Layer.provideMerge(testServer()));
}

/**
A chat whose store holds a turn at `step` until `release` is completed, so the turn can be caught there:
at `startup`, as it stores the person's message, or at `reply`, as it stores the Bot's message once the
Bot finished.
*/
function chatHolding(step: "startup" | "reply", answer: Stream.Stream<AgentEvent, AgentError>) {
  const entered = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();

  const held = <A, E>(effect: Effect.Effect<A, E>) =>
    Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
      Effect.andThen(effect),
    );

  const slowStore = Layer.effect(
    ConversationStore,
    Effect.gen(function* () {
      const store = yield* ConversationStore;

      return ConversationStore.of({
        ...store,
        append: (id, message) =>
          step === (message.role === "user" ? "startup" : "reply")
            ? held(store.append(id, message))
            : store.append(id, message),
      });
    }),
  ).pipe(Layer.provide(conversationStoreLayer));

  const agent = Layer.succeed(AgentRuntime, AgentRuntime.of({ run: () => answer }));

  return {
    entered,
    release,
    layer: chatHandlersLayer.pipe(
      Layer.provide(slowStore),
      Layer.provide(agent),
      Layer.provideMerge(testServer()),
    ),
  };
}

function send(text: string, messageId: string) {
  return { conversationId, botId: assistant.id, messageId: MessageId.make(messageId), text };
}

const types = (events: ReadonlyArray<ChatEvent>) => events.map((event) => event.type);

describe("Chat RPCs", () => {
  it.effect("streams the answer in AG-UI order and keeps both messages", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(ChatRpcs);

      const events = yield* client["Chat.send"](send("Say hi", "user-1")).pipe(Stream.runCollect);
      expect(types(events)).toEqual([
        "RUN_STARTED",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
        "RUN_FINISHED",
      ]);

      const snapshot = yield* client["Chat.open"](opening);
      expect(snapshot.isRunning).toBe(false);
      expect(snapshot.bot.name).toBe("Assistant");
      expect(snapshot.messages.map(({ role, text }) => ({ role, text }))).toEqual([
        { role: "user", text: "Say hi" },
        { role: "assistant", text: "Hi there" },
      ]);
    }).pipe(
      Effect.provide(
        chatWith(
          Stream.make(
            AgentEvent.TextDelta({ text: "Hi" }),
            AgentEvent.TextDelta({ text: " there" }),
            AgentEvent.Done(),
          ),
        ),
      ),
    ),
  );

  it.effect(
    "streams a tool call between the text before and after it, stored as two messages",
    () =>
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(ChatRpcs);

        const events = yield* client["Chat.send"](send("Open example.com", "user-1")).pipe(
          Stream.runCollect,
        );

        const [, before, , , start, args, end, result, after] = events;

        expect(types(events)).toEqual([
          "RUN_STARTED",
          "TEXT_MESSAGE_START",
          "TEXT_MESSAGE_CONTENT",
          "TEXT_MESSAGE_END",
          "TOOL_CALL_START",
          "TOOL_CALL_ARGS",
          "TOOL_CALL_END",
          "TOOL_CALL_RESULT",
          "TEXT_MESSAGE_START",
          "TEXT_MESSAGE_CONTENT",
          "TEXT_MESSAGE_END",
          "RUN_FINISHED",
        ]);

        expect([start, args, end, result]).toEqual([
          {
            type: "TOOL_CALL_START",
            toolCallId: "call-1",
            toolCallName: "navigate",
            parentMessageId: before?.type === "TEXT_MESSAGE_START" ? before.messageId : undefined,
          },
          { type: "TOOL_CALL_ARGS", toolCallId: "call-1", delta: '{"url":"https://example.com"}' },
          { type: "TOOL_CALL_END", toolCallId: "call-1" },
          expect.objectContaining({
            type: "TOOL_CALL_RESULT",
            toolCallId: "call-1",
            content: "Opened https://example.com",
            role: "tool",
          }),
        ]);

        expect(after).toMatchObject({ type: "TEXT_MESSAGE_START" });
        expect(after).not.toEqual(before);

        const snapshot = yield* client["Chat.open"](opening);
        expect(snapshot.messages.map(({ role, text }) => ({ role, text }))).toEqual([
          { role: "user", text: "Open example.com" },
          { role: "assistant", text: "Opening it." },
          { role: "assistant", text: "The title is Example Domain." },
        ]);
      }).pipe(
        Effect.provide(
          chatWith(
            Stream.make(
              AgentEvent.TextDelta({ text: "Opening it." }),
              AgentEvent.ToolCallStarted({
                id: ToolCallId.make("call-1"),
                name: "navigate",
                params: { url: "https://example.com" },
              }),
              AgentEvent.ToolCallFinished({
                id: ToolCallId.make("call-1"),
                result: "Opened https://example.com",
                failed: false,
              }),
              AgentEvent.TextDelta({ text: "The title is Example Domain." }),
              AgentEvent.Done(),
            ),
          ),
        ),
      ),
  );

  it.effect("refuses a second turn while the first runs, and stop ends the first", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(ChatRpcs);
      const seen = yield* Queue.unbounded<ChatEvent>();

      const first = yield* client["Chat.send"](send("Count to a million", "user-1")).pipe(
        Stream.tap((event) => Queue.offer(seen, event)),
        Stream.runCollect,
        Effect.forkChild,
      );

      while ((yield* Queue.take(seen)).type !== "TEXT_MESSAGE_CONTENT");

      const refused = yield* client["Chat.send"](send("Hello?", "user-2")).pipe(
        Stream.runCollect,
        Effect.flip,
      );

      expect(refused).toEqual(new ConversationBusy({ conversationId }));
      expect((yield* client["Chat.open"](opening)).isRunning).toBe(true);

      yield* client["Chat.stop"]({ conversationId });
      const events = yield* Fiber.join(first);
      expect(types(events).slice(-2)).toEqual(["TEXT_MESSAGE_END", "RUN_ERROR"]);
      expect(events.at(-1)).toMatchObject({ type: "RUN_ERROR", code: "stopped" });

      const snapshot = yield* client["Chat.open"](opening);
      expect(snapshot.isRunning).toBe(false);
      expect(snapshot.messages.map(({ role, text }) => ({ role, text }))).toEqual([
        { role: "user", text: "Count to a million" },
        { role: "assistant", text: "One" },
      ]);
    }).pipe(
      Effect.provide(
        chatWith(Stream.concat(Stream.make(AgentEvent.TextDelta({ text: "One" })), Stream.never)),
      ),
    ),
  );

  it.effect("accepts a new send once the previous turn has ended", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(ChatRpcs);

      yield* client["Chat.send"](send("First", "user-1")).pipe(Stream.runCollect);
      const events = yield* client["Chat.send"](send("Second", "user-2")).pipe(Stream.runCollect);

      expect(events.at(-1)?.type).toBe("RUN_FINISHED");

      const snapshot = yield* client["Chat.open"](opening);
      expect(snapshot.messages.map(({ role, text }) => ({ role, text }))).toEqual([
        { role: "user", text: "First" },
        { role: "assistant", text: "Ok" },
        { role: "user", text: "Second" },
        { role: "assistant", text: "Ok" },
      ]);
    }).pipe(
      Effect.provide(
        chatWith(Stream.make(AgentEvent.TextDelta({ text: "Ok" }), AgentEvent.Done())),
      ),
    ),
  );

  it.effect("tells the person when the model went quiet", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(ChatRpcs);

      const events = yield* client["Chat.send"](send("Say hi", "user-1")).pipe(Stream.runCollect);

      expect(types(events)).toEqual(["RUN_STARTED", "RUN_ERROR"]);
      expect(events.at(-1)).toMatchObject({
        type: "RUN_ERROR",
        code: "stalled",
        message: expect.stringContaining("60 seconds"),
      });
    }).pipe(Effect.provide(chatWith(Stream.fail(new Stalled({ waitedMs: 60_000 }))))),
  );

  it.effect(
    "ends a turn stopped while its messages are still being stored, before the model speaks",
    () => {
      const startup = chatHolding(
        "startup",
        Stream.make(AgentEvent.TextDelta({ text: "Too late" }), AgentEvent.Done()),
      );

      return Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(ChatRpcs);

        const sending = yield* client["Chat.send"](send("Say hi", "user-1")).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* Deferred.await(startup.entered);
        yield* client["Chat.stop"]({ conversationId });
        yield* Deferred.succeed(startup.release, undefined);

        const events = yield* Fiber.join(sending);
        expect(types(events)).toEqual(["RUN_STARTED", "RUN_ERROR"]);
        expect(events.at(-1)).toMatchObject({ type: "RUN_ERROR", code: "stopped" });

        const snapshot = yield* client["Chat.open"](opening);
        expect(snapshot.isRunning).toBe(false);
        expect(snapshot.messages.map(({ role, text }) => ({ role, text }))).toEqual([
          { role: "user", text: "Say hi" },
        ]);
      }).pipe(Effect.provide(startup.layer));
    },
  );

  it.effect(
    "records no stop for a turn stopped once its Bot finished, while its reply is stored",
    () => {
      const replying = chatHolding(
        "reply",
        Stream.make(AgentEvent.TextDelta({ text: "Ok" }), AgentEvent.Done()),
      );

      return Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(ChatRpcs);
        const sql = yield* SqlClient.SqlClient;

        const sending = yield* client["Chat.send"](send("Say hi", "user-1")).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* Deferred.await(replying.entered);
        yield* client["Chat.stop"]({ conversationId });
        yield* Deferred.succeed(replying.release, undefined);

        expect((yield* Fiber.join(sending)).at(-1)?.type).toBe("RUN_FINISHED");
        expect(yield* sql`SELECT action, decision FROM audit_rows`).toEqual([]);
      }).pipe(Effect.provide(replying.layer));
    },
  );

  it.effect("has stored the reply and freed the conversation by the time the run finishes", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(ChatRpcs);

      const atFinish = yield* Deferred.make<{
        readonly isRunning: boolean;
        readonly texts: ReadonlyArray<string>;
        readonly next: ReadonlyArray<ChatEvent>;
      }>();

      yield* client["Chat.send"](send("First", "user-1")).pipe(
        Stream.tap((event) =>
          event.type === "RUN_FINISHED"
            ? Effect.gen(function* () {
                const snapshot = yield* client["Chat.open"](opening);

                const next = yield* client["Chat.send"](send("Second", "user-2")).pipe(
                  Stream.runCollect,
                );

                yield* Deferred.succeed(atFinish, {
                  isRunning: snapshot.isRunning,
                  texts: snapshot.messages.map(({ text }) => text),
                  next,
                });
              })
            : Effect.void,
        ),
        Stream.runDrain,
      );

      const seen = yield* Deferred.await(atFinish);
      expect(seen.isRunning).toBe(false);
      expect(seen.texts).toEqual(["First", "Ok"]);
      expect(seen.next.at(-1)?.type).toBe("RUN_FINISHED");
    }).pipe(
      Effect.provide(
        chatWith(Stream.make(AgentEvent.TextDelta({ text: "Ok" }), AgentEvent.Done())),
      ),
    ),
  );

  it.effect("stores what the Bot said and frees the conversation when the client goes away", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(ChatRpcs);
      const seen = yield* Queue.unbounded<ChatEvent>();

      const first = yield* client["Chat.send"](send("Count to a million", "user-1")).pipe(
        Stream.tap((event) => Queue.offer(seen, event)),
        Stream.runDrain,
        Effect.forkChild,
      );

      while ((yield* Queue.take(seen)).type !== "TEXT_MESSAGE_CONTENT");

      yield* Fiber.interrupt(first);

      let snapshot = yield* client["Chat.open"](opening);

      for (let attempt = 0; snapshot.isRunning && attempt < 100; attempt++) {
        yield* Effect.yieldNow;
        snapshot = yield* client["Chat.open"](opening);
      }

      expect(snapshot.isRunning).toBe(false);
      expect(snapshot.messages.map(({ role, text }) => ({ role, text }))).toEqual([
        { role: "user", text: "Count to a million" },
        { role: "assistant", text: "One" },
      ]);
    }).pipe(
      Effect.provide(
        chatWith(Stream.concat(Stream.make(AgentEvent.TextDelta({ text: "One" })), Stream.never)),
      ),
    ),
  );

  it.effect("refuses a retried message id without starting another run", () => {
    let runs = 0;

    const agent = Layer.succeed(
      AgentRuntime,
      AgentRuntime.of({
        run: () =>
          Stream.fromEffect(Effect.sync(() => runs++)).pipe(
            Stream.flatMap(() =>
              Stream.make(AgentEvent.TextDelta({ text: "Ok" }), AgentEvent.Done()),
            ),
          ),
      }),
    );

    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(ChatRpcs);

      yield* client["Chat.send"](send("Say hi", "user-1")).pipe(Stream.runCollect);

      const refused = yield* client["Chat.send"](send("Say hi", "user-1")).pipe(
        Stream.runCollect,
        Effect.flip,
      );

      expect(refused).toEqual(new MessageAlreadySent({ messageId: MessageId.make("user-1") }));
      expect(runs).toBe(1);

      const snapshot = yield* client["Chat.open"](opening);
      expect(snapshot.isRunning).toBe(false);
      expect(snapshot.messages.map(({ role, text }) => ({ role, text }))).toEqual([
        { role: "user", text: "Say hi" },
        { role: "assistant", text: "Ok" },
      ]);

      const next = yield* client["Chat.send"](send("Again", "user-2")).pipe(Stream.runCollect);
      expect(next.at(-1)?.type).toBe("RUN_FINISHED");
    }).pipe(Effect.provide(chatLayer.pipe(Layer.provide(agent), Layer.provideMerge(testServer()))));
  });

  it.effect(
    "runs a conversation as the Bot of its first message, and refuses another Bot naming its own",
    () => {
      const turns: Array<Turn> = [];

      const agent = Layer.succeed(
        AgentRuntime,
        AgentRuntime.of({
          run: (turn) => {
            turns.push(turn);

            return Stream.make(AgentEvent.TextDelta({ text: "Ok" }), AgentEvent.Done());
          },
        }),
      );

      return Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(ChatRpcs);
        const asResearcher = { ...send("Look this up", "user-1"), botId: researcher.id };

        expect((yield* client["Chat.open"]({ conversationId, botId: researcher.id })).bot.id).toBe(
          researcher.id,
        );
        yield* client["Chat.send"](asResearcher).pipe(Stream.runCollect);

        const sentAsAssistant = yield* client["Chat.send"](send("And this", "user-2")).pipe(
          Stream.runCollect,
          Effect.flip,
        );

        const ownBot = new ConversationOfAnotherBot({ conversationId, botId: researcher.id });

        expect(sentAsAssistant).toEqual(ownBot);
        expect(yield* Effect.flip(client["Chat.open"](opening))).toEqual(ownBot);
        expect(
          (yield* client["Chat.open"]({ conversationId, botId: researcher.id })).messages.map(
            (message) => message.text,
          ),
        ).toEqual(["Look this up", "Ok"]);
        expect(turns.map((turn) => turn.bot)).toEqual([researcher.id]);
        expect(turns[0]?.instructions).toContain("You are Researcher.");
      }).pipe(
        Effect.provide(chatLayer.pipe(Layer.provide(agent), Layer.provideMerge(testServer()))),
      );
    },
  );

  it.effect("runs each message as a new run of its conversation, the run its events name", () => {
    const turns: Array<Turn> = [];

    const agent = Layer.succeed(
      AgentRuntime,
      AgentRuntime.of({
        run: (turn) => {
          turns.push(turn);

          return Stream.make(AgentEvent.TextDelta({ text: "Ok" }), AgentEvent.Done());
        },
      }),
    );

    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(ChatRpcs);

      const started = yield* Effect.forEach(["user-1", "user-2"], (messageId) =>
        client["Chat.send"](send("Hi", messageId)).pipe(
          Stream.runCollect,
          Effect.map((events) => events.find((event) => event.type === "RUN_STARTED")),
        ),
      );

      expect(turns.map((turn) => turn.conversation)).toEqual([conversationId, conversationId]);
      expect(new Set(turns.map((turn) => turn.run)).size).toBe(2);
      expect(started.map((event) => event?.runId)).toEqual(turns.map((turn) => turn.run));
    }).pipe(Effect.provide(chatLayer.pipe(Layer.provide(agent), Layer.provideMerge(testServer()))));
  });

  it.effect("refuses a Bot the server does not know, storing nothing and running no turn", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(ChatRpcs);
      const ghost = BotId.make("ghost");

      const opened = yield* Effect.flip(client["Chat.open"]({ conversationId, botId: ghost }));

      const sent = yield* client["Chat.send"]({ ...send("Hi", "user-1"), botId: ghost }).pipe(
        Stream.runCollect,
        Effect.flip,
      );

      expect(opened).toEqual(new UnknownBot({ botId: ghost }));
      expect(sent).toEqual(new UnknownBot({ botId: ghost }));
      expect((yield* client["Chat.open"](opening)).messages).toEqual([]);
    }).pipe(Effect.provide(chatWith(Stream.die("no turn runs for an unknown Bot")))),
  );
});
