import {
  type ChatEvent,
  ChatRpcs,
  ConversationBusy,
  ConversationId,
  MessageId,
} from "@aobot/domain";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Queue, Stream } from "effect";
import { RpcTest } from "effect/rpc";
import { AgentEvent, type AgentError, AgentRuntime, Stalled } from "../agent/public.ts";
import { chatLayer } from "./public.ts";
import { testDatabase } from "./testing/test-database.ts";

const conversationId = ConversationId.make("conversation-1");

function chatWith(answer: Stream.Stream<AgentEvent, AgentError>) {
  const agent = Layer.succeed(AgentRuntime, AgentRuntime.of({ run: () => answer }));

  return chatLayer.pipe(Layer.provide([agent, testDatabase]));
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
});
