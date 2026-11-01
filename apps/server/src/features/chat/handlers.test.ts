import {
  type ChatEvent,
  ChatRpcs,
  ConversationBusy,
  ConversationId,
  MessageAlreadySent,
  MessageId,
  ToolCallId,
} from "@aobot/domain";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Queue, Stream } from "effect";
import { RpcTest } from "effect/rpc";
import { AgentEvent, type AgentError, AgentRuntime, Stalled } from "../agent/public.ts";
import { ConversationStore, conversationStoreLayer } from "./conversation-store.ts";
import { chatHandlersLayer } from "./handlers.ts";
import { chatLayer } from "./public.ts";
import { testDatabase } from "./testing/test-database.ts";

const conversationId = ConversationId.make("conversation-1");

function chatWith(answer: Stream.Stream<AgentEvent, AgentError>) {
  const agent = Layer.succeed(AgentRuntime, AgentRuntime.of({ run: () => answer }));

  return chatLayer.pipe(Layer.provide([agent, testDatabase]));
}

/** A chat whose store holds `ensure` open until `release` is completed, so a turn can be caught mid-startup. */
function chatWithSlowStartup(answer: Stream.Stream<AgentEvent, AgentError>) {
  const entered = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();

  const slowStore = Layer.effect(
    ConversationStore,
    Effect.gen(function* () {
      const store = yield* ConversationStore;

      return ConversationStore.of({
        ...store,
        ensure: (id, botId) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(store.ensure(id, botId)),
          ),
      });
    }),
  ).pipe(Layer.provide(conversationStoreLayer));

  const agent = Layer.succeed(AgentRuntime, AgentRuntime.of({ run: () => answer }));

  return {
    entered,
    release,
    layer: chatHandlersLayer.pipe(Layer.provide(slowStore), Layer.provide([agent, testDatabase])),
  };
}

function send(text: string, messageId: string) {
  return { conversationId, messageId: MessageId.make(messageId), text };
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

      const snapshot = yield* client["Chat.open"]({ conversationId });
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

        const snapshot = yield* client["Chat.open"]({ conversationId });
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
      expect((yield* client["Chat.open"]({ conversationId })).isRunning).toBe(true);

      yield* client["Chat.stop"]({ conversationId });
      const events = yield* Fiber.join(first);
      expect(types(events).slice(-2)).toEqual(["TEXT_MESSAGE_END", "RUN_ERROR"]);
      expect(events.at(-1)).toMatchObject({ type: "RUN_ERROR", code: "stopped" });

      const snapshot = yield* client["Chat.open"]({ conversationId });
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

      const snapshot = yield* client["Chat.open"]({ conversationId });
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
      const startup = chatWithSlowStartup(
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

        const snapshot = yield* client["Chat.open"]({ conversationId });
        expect(snapshot.isRunning).toBe(false);
        expect(snapshot.messages.map(({ role, text }) => ({ role, text }))).toEqual([
          { role: "user", text: "Say hi" },
        ]);
      }).pipe(Effect.provide(startup.layer));
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
                const snapshot = yield* client["Chat.open"]({ conversationId });

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

      let snapshot = yield* client["Chat.open"]({ conversationId });

      for (let attempt = 0; snapshot.isRunning && attempt < 100; attempt++) {
        yield* Effect.yieldNow;
        snapshot = yield* client["Chat.open"]({ conversationId });
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

      const snapshot = yield* client["Chat.open"]({ conversationId });
      expect(snapshot.isRunning).toBe(false);
      expect(snapshot.messages.map(({ role, text }) => ({ role, text }))).toEqual([
        { role: "user", text: "Say hi" },
        { role: "assistant", text: "Ok" },
      ]);

      const next = yield* client["Chat.send"](send("Again", "user-2")).pipe(Stream.runCollect);
      expect(next.at(-1)?.type).toBe("RUN_FINISHED");
    }).pipe(Effect.provide(chatLayer.pipe(Layer.provide([agent, testDatabase]))));
  });
});
