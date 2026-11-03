import { ChatRpcs, ConversationId, MessageId } from "@aobot/domain";
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Layer, Option, Predicate, Stream, Tracer } from "effect";
import { LanguageModel, type Response, Toolkit } from "effect/ai";
import { RpcTest } from "effect/rpc";
import { AgentEvent, AgentRuntime, layerApi } from "../agent/public.ts";
import { chatLayer } from "./public.ts";
import { assistant } from "../bots/testing/test-bots.ts";
import { testServer } from "./testing/test-server.ts";

/** A tracer that keeps every span it starts, so a test can read the tree a turn produced. */
function recordingTracer() {
  const spans: Array<Tracer.Span> = [];

  const tracer = Tracer.make({
    span: (options) => {
      const span = Tracer.nativeTracer.span(options);
      spans.push(span);

      return span;
    },
  });

  return { spans, layer: Layer.succeed(Tracer.Tracer, tracer) };
}

/** The names from the trace root down to `span`. */
function ancestry(span: Tracer.Span): ReadonlyArray<string> {
  const parent = Option.filter(span.parent, (parent): parent is Tracer.Span =>
    Predicate.isTagged(parent, "Span"),
  );

  return Option.match(parent, {
    onNone: () => [span.name],
    onSome: (parent) => [...ancestry(parent), span.name],
  });
}

const answer: Array<Response.StreamPartEncoded> = [
  { type: "text-delta", id: "text-1", delta: "Hi" },
  {
    type: "finish",
    reason: "stop",
    usage: {
      inputTokens: { uncached: 1, total: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: undefined, reasoning: undefined },
    },
  },
];

const model = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: () => Effect.die("the test model only streams"),
    streamText: () => Stream.fromIterable(answer),
  }),
);

const agent = layerApi(Toolkit.empty, { maxSteps: 8, stallTimeout: Duration.seconds(60) }).pipe(
  Layer.provide(model),
);

describe("Chat tracing", () => {
  it.effect("records one turn as one trace named Chat.turn, with the model call inside it", () => {
    const recorder = recordingTracer();

    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(ChatRpcs);

      yield* client["Chat.send"]({
        conversationId: ConversationId.make("conversation-1"),
        botId: assistant.id,
        messageId: MessageId.make("user-1"),
        text: "Say hi",
      }).pipe(Stream.runCollect);

      const named = (name: string) => recorder.spans.filter((span) => span.name === name);

      const turns = named("Chat.turn");
      expect(turns.map((span) => Option.isNone(span.parent))).toEqual([true]);
      expect(turns[0]?.attributes.get("chat.bot")).toBe(assistant.id);
      expect(turns[0]?.attributes.get("chat.status")).toBe("finished");
      const traceId = turns[0]?.traceId;

      const setup = named("Chat.send").filter((span) => span.traceId === traceId);
      expect(setup.map(ancestry)).toEqual([["Chat.turn", "Chat.send"]]);

      const modelCalls = named("LanguageModel.streamText");
      expect(modelCalls.map((span) => span.traceId)).toEqual([traceId]);
      expect(modelCalls.map(ancestry)).toEqual([
        expect.arrayContaining(["Chat.turn", "AgentRuntime.run", "LanguageModel.streamText"]),
      ]);
    }).pipe(
      Effect.provide(chatLayer.pipe(Layer.provide(agent), Layer.provide(testServer()))),
      Effect.provide(recorder.layer),
    );
  });

  it.effect("records a turn the person stopped as cancelled", () => {
    const recorder = recordingTracer();

    const working = Layer.succeed(
      AgentRuntime,
      AgentRuntime.of({
        run: () => Stream.concat(Stream.make(AgentEvent.TextDelta({ text: "One" })), Stream.never),
      }),
    );

    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(ChatRpcs);
      const conversationId = ConversationId.make("conversation-1");

      yield* client["Chat.send"]({
        conversationId,
        botId: assistant.id,
        messageId: MessageId.make("user-1"),
        text: "Count to a million",
      }).pipe(
        Stream.tap((event) =>
          event.type === "TEXT_MESSAGE_CONTENT"
            ? client["Chat.stop"]({ conversationId })
            : Effect.void,
        ),
        Stream.runDrain,
      );

      const turns = recorder.spans.filter((span) => span.name === "Chat.turn");
      expect(turns.map((span) => span.attributes.get("chat.status"))).toEqual(["cancelled"]);
    }).pipe(
      Effect.provide(chatLayer.pipe(Layer.provide(working), Layer.provide(testServer()))),
      Effect.provide(recorder.layer),
    );
  });
});
