import { ChatRpcs, ConversationId, MessageId } from "@aobot/domain";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Layer, Option, Predicate, Stream, Tracer } from "effect";
import { LanguageModel, type Prompt, type Response } from "effect/ai";
import { RpcTest } from "effect/rpc";
import { SqlClient } from "effect/sql";
import { layerApi } from "../features/agent/public.ts";
import { auditLogLayer, migrateAudit } from "../features/audit/public.ts";
import { botToolkit } from "../features/bots/public.ts";
import { chatLayer, migrateChat } from "../features/chat/public.ts";
import { Computers } from "../features/computers/public.ts";
import { botToolHandlers, gatewayLayer, migrateGateway } from "../features/gateway/public.ts";
import { toolInputsRedacted } from "../shared/span-redaction.ts";

/**
The `api` runtime wired as `main.ts` wires it, with only the model and the computer faked: a tool call
the model makes reaches the gateway inside the turn's trace, and its result reaches the model marked.
*/

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

function ancestry(span: Tracer.Span): ReadonlyArray<string> {
  const parent = Option.filter(span.parent, (parent): parent is Tracer.Span =>
    Predicate.isTagged(parent, "Span"),
  );

  return Option.match(parent, {
    onNone: () => [span.name],
    onSome: (parent) => [...ancestry(parent), span.name],
  });
}

const usage = {
  inputTokens: { uncached: 1, total: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: undefined, reasoning: undefined },
};

/** Answers with `steps` in order, one per call; keeps every prompt it was sent. */
function steppingModel(steps: ReadonlyArray<ReadonlyArray<Response.StreamPartEncoded>>) {
  const prompts: Array<Prompt.Prompt> = [];

  const layer = Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () => Effect.die("this model only streams"),
      streamText: (options) => {
        prompts.push(options.prompt);

        return Stream.fromIterable(steps[prompts.length - 1] ?? []);
      },
    }),
  );

  return { prompts, layer };
}

/** Calls navigate first, then answers. */
function navigatingModel() {
  return steppingModel([
    [
      { type: "tool-call", id: "call-1", name: "navigate", params: { url: "https://example.com" } },
      { type: "finish", reason: "tool-calls", usage },
    ],
    [
      { type: "text-delta", id: "text-1", delta: "Example Domain" },
      { type: "finish", reason: "stop", usage },
    ],
  ]);
}

const computers = Layer.succeed(
  Computers,
  Computers.of({
    ensure: Effect.succeed({
      act: () =>
        Effect.succeed({
          action: "navigate",
          url: "https://example.com/",
          title: "Example Domain",
          snapshot: '- searchbox "Search" [ref=e1]',
          truncated: false,
        } as const),
    }),
    stop: Effect.void,
    reset: Effect.void,
    list: Effect.succeed([]),
  }),
);

const database = Layer.effectDiscard(Effect.all([migrateChat, migrateAudit, migrateGateway])).pipe(
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
  Layer.fresh,
);

describe("a tool call in an api turn", () => {
  it.effect(
    "runs Gateway.act inside Chat.turn and hands the model the result marked untrusted",
    () => {
      const recorder = recordingTracer();
      const model = navigatingModel();

      const gateway = gatewayLayer.pipe(Layer.provide([auditLogLayer, computers]));

      const agent = layerApi(botToolkit, { maxSteps: 4, stallTimeout: Duration.seconds(60) }).pipe(
        Layer.provide(botToolHandlers),
        Layer.provide(gateway),
        Layer.provide(model.layer),
      );

      return Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(ChatRpcs);
        const sql = yield* SqlClient.SqlClient;

        yield* client["Chat.send"]({
          conversationId: ConversationId.make("conversation-1"),
          messageId: MessageId.make("user-1"),
          text: "Open example.com and tell me the page title.",
        }).pipe(Stream.runCollect);

        const [turn] = recorder.spans.filter((span) => span.name === "Chat.turn");
        const acts = recorder.spans.filter((span) => span.name === "Gateway.act");
        expect(acts.map(ancestry)).toEqual([
          expect.arrayContaining(["Chat.turn", "AgentRuntime.run", "Gateway.act"]),
        ]);

        const rows = yield* sql`SELECT decision, action, trace_id FROM audit_rows ORDER BY seq`;
        expect(rows).toEqual([
          { decision: "allow", action: "navigate", trace_id: turn?.traceId },
          { decision: "succeeded", action: "navigate", trace_id: turn?.traceId },
        ]);

        const toolResults = JSON.stringify(
          model.prompts[1]?.content.filter((m) => m.role === "tool"),
        );

        expect(toolResults).toContain("untrusted_data");
        expect(toolResults).toContain("Example Domain");
      }).pipe(
        Effect.provide(chatLayer.pipe(Layer.provide(agent))),
        Effect.provide(database),
        Effect.provide(recorder.layer),
      );
    },
  );

  it.effect("keeps what a Bot typed out of every span, as out of the audit trail", () => {
    const recorder = recordingTracer();
    const typed = "hunter2-correct-horse";

    const model = steppingModel([
      [
        { type: "tool-call", id: "call-1", name: "snapshot", params: {} },
        { type: "finish", reason: "tool-calls", usage },
      ],
      [
        { type: "tool-call", id: "call-2", name: "type", params: { ref: "e1", text: typed } },
        { type: "finish", reason: "tool-calls", usage },
      ],
      [
        { type: "text-delta", id: "text-1", delta: "Typed it." },
        { type: "finish", reason: "stop", usage },
      ],
    ]);

    const gateway = gatewayLayer.pipe(Layer.provide([auditLogLayer, computers]));

    const agent = layerApi(botToolkit, { maxSteps: 4, stallTimeout: Duration.seconds(60) }).pipe(
      Layer.provide(botToolHandlers),
      Layer.provide(gateway),
      Layer.provide(model.layer),
    );

    return Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(ChatRpcs);
      const sql = yield* SqlClient.SqlClient;

      yield* client["Chat.send"]({
        conversationId: ConversationId.make("conversation-1"),
        messageId: MessageId.make("user-1"),
        text: "Type my password into the search box.",
      }).pipe(Stream.runCollect);

      const rows = yield* sql`SELECT decision, action, detail FROM audit_rows ORDER BY seq`;
      expect(rows).toContainEqual({
        decision: "allow",
        action: "type",
        detail: JSON.stringify({
          ref: "e1",
          role: "searchbox",
          name: "Search",
          text: "[21 chars]",
        }),
      });

      const attributes = recorder.spans.flatMap((span) => [...span.attributes.values()]);
      expect(attributes.length).toBeGreaterThan(0);
      expect(JSON.stringify(attributes)).not.toContain(typed);
      expect(JSON.stringify(rows)).not.toContain(typed);
    }).pipe(
      Effect.provide(chatLayer.pipe(Layer.provide(agent))),
      Effect.provide(database),
      Effect.provide(toolInputsRedacted.pipe(Layer.provide(recorder.layer))),
    );
  });
});
