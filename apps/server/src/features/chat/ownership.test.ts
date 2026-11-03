import {
  type ChatEvent,
  ChatRpcs,
  ConversationId,
  MessageId,
  NotYourConversation,
} from "@aobot/domain";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Queue, Stream } from "effect";
import { RpcTest } from "effect/rpc";
import { SqlClient } from "effect/sql";
import type { PersonActor } from "../../shared/actor.ts";
import { alice, bob } from "../../shared/testing/people.ts";
import { signedInAs } from "../../shared/testing/signed-in.ts";
import { AgentEvent, AgentRuntime, type Turn } from "../agent/public.ts";
import { assistant, researcher } from "../bots/testing/test-bots.ts";
import { ConversationStore, conversationStoreLayer, Standing } from "./conversation-store.ts";
import { chatLayer } from "./public.ts";
import { testDatabase } from "./testing/test-database.ts";
import { testServer } from "./testing/test-server.ts";

const first = ConversationId.make("conversation-1");

const second = ConversationId.make("conversation-2");

/** A chat whose Bot answers "Ok" at once, keeping every turn it was asked to run. */
function answering() {
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

  return { turns, layer: chatLayer.pipe(Layer.provide(agent), Layer.provideMerge(testServer())) };
}

/** The chat as `person` calls it from their page. */
const clientFor = (person: PersonActor) =>
  RpcTest.makeClient(ChatRpcs).pipe(Effect.provide(signedInAs(person)));

/** `text` sent to `conversation`'s Bot, `assistant` unless named, as a message the page names anew. */
function message(conversation: ConversationId, text: string, botId = assistant.id) {
  return {
    conversationId: conversation,
    botId,
    messageId: MessageId.make(crypto.randomUUID()),
    text,
  };
}

/** A chat whose Bot says nothing. */
const silent = chatLayer.pipe(
  Layer.provide(Layer.succeed(AgentRuntime, AgentRuntime.of({ run: () => Stream.empty }))),
  Layer.provideMerge(testServer()),
);

const texts = Effect.fnUntraced(function* (
  client: Effect.Success<ReturnType<typeof clientFor>>,
  conversation: ConversationId,
) {
  const snapshot = yield* client["Chat.open"]({
    conversationId: conversation,
    botId: assistant.id,
  });

  return snapshot.messages.map((stored) => stored.text);
});

describe("given Alice's conversation", () => {
  it.effect(
    "refuses Bob opening, writing to, stopping and reading it, and runs no turn for him",
    () => {
      const chat = answering();

      return Effect.gen(function* () {
        const asAlice = yield* clientFor(alice);
        const asBob = yield* clientFor(bob);
        yield* asAlice["Chat.send"](message(first, "My plans")).pipe(Stream.runCollect);

        const refused = new NotYourConversation({ conversationId: first });
        const opening = { conversationId: first, botId: assistant.id };

        expect(yield* Effect.flip(asBob["Chat.open"](opening))).toEqual(refused);
        expect(
          yield* Effect.flip(asBob["Chat.send"](message(first, "Show me")).pipe(Stream.runCollect)),
        ).toEqual(refused);
        expect(yield* Effect.flip(asBob["Chat.stop"]({ conversationId: first }))).toEqual(refused);
        expect(yield* Effect.flip(asBob["Chat.read"]({ conversationId: first }))).toEqual(refused);

        expect(chat.turns).toHaveLength(1);
        expect(yield* texts(asAlice, first)).toEqual(["My plans", "Ok"]);
      }).pipe(Effect.provide(chat.layer));
    },
  );

  it.effect("lets Bob stop nothing of hers while her turn runs", () => {
    const working = Layer.succeed(
      AgentRuntime,
      AgentRuntime.of({
        run: () => Stream.concat(Stream.make(AgentEvent.TextDelta({ text: "One" })), Stream.never),
      }),
    );

    return Effect.gen(function* () {
      const asAlice = yield* clientFor(alice);
      const asBob = yield* clientFor(bob);
      const seen = yield* Queue.unbounded<ChatEvent>();

      const turn = yield* asAlice["Chat.send"](message(first, "Count")).pipe(
        Stream.tap((event) => Queue.offer(seen, event)),
        Stream.runCollect,
        Effect.forkChild,
      );

      while ((yield* Queue.take(seen)).type !== "TEXT_MESSAGE_CONTENT");

      yield* Effect.flip(asBob["Chat.stop"]({ conversationId: first }));
      expect(
        (yield* asAlice["Chat.open"]({ conversationId: first, botId: assistant.id })).isRunning,
      ).toBe(true);

      yield* asAlice["Chat.stop"]({ conversationId: first });
      expect((yield* Fiber.join(turn)).at(-1)).toMatchObject({
        type: "RUN_ERROR",
        code: "stopped",
      });
    }).pipe(
      Effect.provide(chatLayer.pipe(Layer.provide(working), Layer.provideMerge(testServer()))),
    );
  });

  it.effect("lists hers to her, the one written to last first, and none to Bob", () => {
    const chat = answering();

    return Effect.gen(function* () {
      const asAlice = yield* clientFor(alice);
      const asBob = yield* clientFor(bob);

      yield* asAlice["Chat.send"](message(first, "First plans")).pipe(Stream.runCollect);
      yield* asAlice["Chat.send"](message(second, "Look this up", researcher.id)).pipe(
        Stream.runCollect,
      );
      yield* asAlice["Chat.send"](message(first, "More plans")).pipe(Stream.runCollect);

      expect(yield* asAlice["Chat.list"]()).toEqual([
        { conversationId: first, botId: assistant.id, preview: "Ok", unread: true },
        { conversationId: second, botId: researcher.id, preview: "Ok", unread: true },
      ]);
      expect(yield* asBob["Chat.list"]()).toEqual([]);
    }).pipe(Effect.provide(chat.layer));
  });
});

describe("a conversation's unread mark", () => {
  it.effect("is set by the Bot's message and cleared by opening or reading it", () => {
    const chat = answering();

    return Effect.gen(function* () {
      const asAlice = yield* clientFor(alice);

      const unread = asAlice["Chat.list"]().pipe(
        Effect.map((listed) => listed.map((summary) => summary.unread)),
      );

      yield* asAlice["Chat.send"](message(first, "Hi")).pipe(Stream.runCollect);
      expect(yield* unread).toEqual([true]);

      yield* asAlice["Chat.read"]({ conversationId: first });
      expect(yield* unread).toEqual([false]);

      yield* asAlice["Chat.send"](message(first, "Again")).pipe(Stream.runCollect);
      expect(yield* unread).toEqual([true]);

      yield* asAlice["Chat.open"]({ conversationId: first, botId: assistant.id });
      expect(yield* unread).toEqual([false]);
    }).pipe(Effect.provide(chat.layer));
  });

  it.effect("is not set by the person's own message", () =>
    Effect.gen(function* () {
      const asAlice = yield* clientFor(alice);

      yield* asAlice["Chat.send"](message(first, "Hi")).pipe(Stream.runCollect);

      expect(yield* asAlice["Chat.list"]()).toEqual([
        { conversationId: first, botId: assistant.id, preview: "Hi", unread: false },
      ]);
    }).pipe(Effect.provide(silent)),
  );
});

describe("the conversation list", () => {
  it.effect(
    "previews the start of a long message, and leaves out a Bot no longer in the file",
    () =>
      Effect.gen(function* () {
        const asAlice = yield* clientFor(alice);
        const sql = yield* SqlClient.SqlClient;

        yield* asAlice["Chat.send"](message(first, "x".repeat(500))).pipe(Stream.runCollect);
        yield* sql`
        INSERT INTO conversations (id, bot_id, owner_id) VALUES ('retired', 'ghost', ${alice.email})
      `;
        yield* sql`
        INSERT INTO messages (id, conversation_id, role, text) VALUES ('m', 'retired', 'user', 'Hi')
      `;

        expect(yield* asAlice["Chat.list"]()).toEqual([
          { conversationId: first, botId: assistant.id, preview: "x".repeat(120), unread: false },
        ]);
      }).pipe(Effect.provide(silent)),
  );
});

describe("a conversation from before conversations had owners", () => {
  it.effect("opens for nobody and lists for nobody", () => {
    const chat = answering();

    return Effect.gen(function* () {
      const asAlice = yield* clientFor(alice);
      const sql = yield* SqlClient.SqlClient;

      yield* sql`INSERT INTO conversations (id, bot_id) VALUES (${first}, 'assistant')`;
      yield* sql`
        INSERT INTO messages (id, conversation_id, role, text) VALUES ('m', ${first}, 'user', 'Old')
      `;

      expect(
        yield* Effect.flip(asAlice["Chat.open"]({ conversationId: first, botId: assistant.id })),
      ).toEqual(new NotYourConversation({ conversationId: first }));
      expect(yield* asAlice["Chat.list"]()).toEqual([]);
    }).pipe(Effect.provide(chat.layer));
  });
});

describe("two people claiming one new conversation at once", () => {
  it.effect("give it to exactly one of them", () =>
    Effect.gen(function* () {
      const store = yield* ConversationStore;

      const claims = yield* Effect.all(
        [alice, bob].map((person) => store.claim(first, assistant.id, person)),
        { concurrency: "unbounded" },
      );

      expect(claims.filter(Standing.$is("Mine"))).toHaveLength(1);
      expect(claims.filter(Standing.$is("NotYours"))).toHaveLength(1);
      expect(yield* store.standing(first, alice)).toEqual(claims[0]);
    }).pipe(Effect.provide(conversationStoreLayer), Effect.provide(testDatabase)),
  );
});
