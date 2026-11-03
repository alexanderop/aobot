import {
  BotPaused,
  type ChatEvent,
  ChatRpcs,
  ConversationId,
  MessageId,
  PauseUnknown,
} from "@aobot/domain";
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Fiber, Layer, Queue, Ref, Stream } from "effect";
import { RpcTest } from "effect/rpc";
import { TestClock } from "effect/testing";
import { AgentEvent, AgentRuntime } from "../agent/public.ts";
import { assistant, testBots } from "../bots/testing/test-bots.ts";
import { Turns } from "../lifecycle/public.ts";
import { testLifecycle } from "../lifecycle/testing/test-lifecycle.ts";
import { chatLayer } from "./public.ts";
import { testDatabase } from "./testing/test-database.ts";
import { testServer } from "./testing/test-server.ts";

const conversationId = ConversationId.make("conversation-1");

const opening = { conversationId, botId: assistant.id };

function send(text: string, messageId: string) {
  return { conversationId, botId: assistant.id, messageId: MessageId.make(messageId), text };
}

/** A Bot that says "One" and then works on forever, until its turn is stopped. */
const working = Layer.succeed(
  AgentRuntime,
  AgentRuntime.of({
    run: () => Stream.concat(Stream.make(AgentEvent.TextDelta({ text: "One" })), Stream.never),
  }),
);

/** A Bot that answers "Ok" at once. */
const answering = Layer.succeed(
  AgentRuntime,
  AgentRuntime.of({
    run: () => Stream.make(AgentEvent.TextDelta({ text: "Ok" }), AgentEvent.Done()),
  }),
);

/** One server's chat with its lifecycle beside it, failing the next reads of the pause state while `failures` says. */
function server(agent: Layer.Layer<AgentRuntime>, failures: Ref.Ref<number> = Ref.makeUnsafe(0)) {
  return chatLayer.pipe(Layer.provide(agent), Layer.provideMerge(testServer(failures)));
}

/** Runs a turn in the background, once the Bot has said its first word in it. */
const afterAWord = <E>(sending: Stream.Stream<ChatEvent, E>) =>
  Effect.gen(function* () {
    const seen = yield* Queue.unbounded<ChatEvent>();

    const turn = yield* sending.pipe(
      Stream.tap((event) => Queue.offer(seen, event)),
      Stream.runCollect,
      Effect.forkChild,
    );

    while ((yield* Queue.take(seen)).type !== "TEXT_MESSAGE_CONTENT");

    return turn;
  });

describe("given a paused Bot", () => {
  it.effect("refuses its message before storing anything, and answers again once resumed", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(ChatRpcs);
      const turns = yield* Turns;

      yield* turns.pause(assistant.id);

      const refused = yield* client["Chat.send"](send("Hi", "user-1")).pipe(
        Stream.runCollect,
        Effect.flip,
      );

      expect(refused).toEqual(new BotPaused({ botId: assistant.id }));
      expect(yield* client["Chat.open"](opening)).toMatchObject({ messages: [], isRunning: false });

      yield* turns.resume(assistant.id);

      const events = yield* client["Chat.send"](send("Hi", "user-1")).pipe(Stream.runCollect);
      expect(events.at(-1)?.type).toBe("RUN_FINISHED");
    }).pipe(Effect.provide(server(answering))),
  );

  it.effect("ends a turn running when it is paused, saying so and keeping what the Bot said", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(ChatRpcs);
      const turn = yield* afterAWord(client["Chat.send"](send("Count to a million", "user-1")));

      yield* (yield* Turns).pause(assistant.id);

      const events = yield* Fiber.join(turn);
      expect(events.at(-1)).toEqual({
        type: "RUN_ERROR",
        code: "paused",
        message: "This Bot is paused.",
      });

      const snapshot = yield* client["Chat.open"](opening);
      expect(snapshot.isRunning).toBe(false);
      expect(snapshot.messages.map(({ text }) => text)).toEqual(["Count to a million", "One"]);
    }).pipe(Effect.provide(server(working))),
  );
});

describe("given a database that cannot say whether the Bot is paused", () => {
  it.effect("refuses a message once three reads in a row failed, storing nothing", () => {
    const failures = Ref.makeUnsafe(0);

    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(ChatRpcs);
      yield* Stream.runHead((yield* Turns).paused);
      yield* Ref.set(failures, 3);

      const sending = yield* client["Chat.send"](send("Hi", "user-1")).pipe(
        Stream.runCollect,
        Effect.flip,
        Effect.forkChild,
      );

      yield* TestClock.adjust("1 second");

      expect(yield* Fiber.join(sending)).toEqual(new PauseUnknown({ botId: assistant.id }));
      expect(yield* client["Chat.open"](opening)).toMatchObject({ messages: [], isRunning: false });
    }).pipe(Effect.provide(server(answering, failures)));
  });

  it.effect("starts the turn when a read answers after two failed", () => {
    const failures = Ref.makeUnsafe(0);

    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(ChatRpcs);
      yield* Stream.runHead((yield* Turns).paused);
      yield* Ref.set(failures, 2);

      const sending = yield* client["Chat.send"](send("Hi", "user-1")).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* TestClock.adjust("1 second");

      expect((yield* Fiber.join(sending)).at(-1)?.type).toBe("RUN_FINISHED");
    }).pipe(Effect.provide(server(answering, failures)));
  });
});

describe("given two servers on one database", () => {
  it.effect("stops a turn on one within five seconds of a pause on the other", () =>
    Effect.gen(function* () {
      const database = yield* Layer.build(testDatabase);

      const replica = chatLayer.pipe(
        Layer.provide(working),
        Layer.provideMerge(Layer.mergeAll(testLifecycle(), testBots)),
        Layer.provide(Layer.succeedContext(database)),
      );

      const a = yield* Layer.build(replica);
      const b = yield* Layer.build(replica);
      const onB = yield* RpcTest.makeClient(ChatRpcs).pipe(Effect.provide(b));

      const turn = yield* afterAWord(onB["Chat.send"](send("Count to a million", "user-1")));

      yield* Context.get(a, Turns).pause(assistant.id);
      yield* TestClock.adjust("4 seconds");
      expect((yield* onB["Chat.open"](opening)).isRunning).toBe(true);

      yield* TestClock.adjust("1 second");
      expect((yield* Fiber.join(turn)).at(-1)).toMatchObject({ type: "RUN_ERROR", code: "paused" });
      expect((yield* onB["Chat.open"](opening)).isRunning).toBe(false);
    }),
  );
});
