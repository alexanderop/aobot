import { BotId, ConversationId, PauseRpcs, UnknownBot } from "@aobot/domain";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Ref, Schema, Stream } from "effect";
import { RpcTest } from "effect/rpc";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { assistant, researcher, testBots } from "../bots/testing/test-bots.ts";
import { pauseHandlers } from "./rpcs.ts";
import { testLifecycle } from "./testing/test-lifecycle.ts";
import { type StopReason, Turns } from "./turns.ts";

const first = ConversationId.make("conversation-1");

const second = ConversationId.make("conversation-2");

/** One server's lifecycle on a fresh database, failing the next reads of the pause state while `failures` says. */
function server(failures: Ref.Ref<number> = Ref.makeUnsafe(0)) {
  return testLifecycle(failures).pipe(
    Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
  );
}

const Rows = Schema.Array(
  Schema.Struct({
    action: Schema.String,
    decision: Schema.String,
    initiator: Schema.String,
    bot: Schema.String,
    reason: Schema.String,
  }),
);

/** Every audit row, oldest first: `action · decision`, the initiator, and the Bot and reason when it names them. */
const trail = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const rows = yield* sql`
    SELECT action, decision, initiator_kind AS initiator,
      coalesce(json_extract(detail, '$.bot'), '') AS bot,
      coalesce(json_extract(detail, '$.reason'), '') AS reason
    FROM audit_rows ORDER BY seq
  `;

  return (yield* Schema.decodeUnknownEffect(Rows)(rows)).map(
    ({ action, decision, initiator, bot, reason }) =>
      [`${action} · ${decision}`, initiator, bot, reason].filter((part) => part !== "").join(" | "),
  );
});

/** Waits until the check of running turns has read the pause state once, as it does when the server starts. */
const firstCheck = (turns: Turns["Service"]) => Stream.runHead(turns.paused);

/** What stopped a claimed turn, or none while it runs. */
const stopOf = (stopped: Deferred.Deferred<StopReason>) =>
  Deferred.isDone(stopped).pipe(
    Effect.flatMap((done) =>
      done
        ? Effect.map(Deferred.await(stopped), (reason) => Option.some(reason._tag))
        : Effect.succeedNone,
    ),
  );

describe("Turns", () => {
  it.effect(
    "refuses a paused Bot's turn, writes the deny row, and starts it again once resumed",
    () =>
      Effect.gen(function* () {
        const turns = yield* Turns;

        yield* turns.pause(assistant.id);
        yield* turns.pause(assistant.id);

        const refused = yield* turns.start(first, assistant.id).pipe(Effect.flip);
        expect(refused._tag).toBe("BotPaused");
        expect(yield* turns.isRunning(first)).toBe(false);

        yield* turns.start(second, researcher.id);

        yield* turns.resume(assistant.id);
        yield* turns.resume(assistant.id);
        yield* turns.start(first, assistant.id);

        expect(yield* trail).toEqual([
          "bot.paused · allow | person | assistant",
          "bot.paused · succeeded | person",
          "turn · deny | person | assistant | bot paused",
          "bot.resumed · allow | person | assistant",
          "bot.resumed · succeeded | person",
        ]);
      }).pipe(Effect.provide(server())),
  );

  it.effect("stops a running turn of a Bot at once when it is paused, and only that Bot's", () =>
    Effect.gen(function* () {
      const turns = yield* Turns;
      const paused = yield* turns.start(first, assistant.id);
      const other = yield* turns.start(second, researcher.id);

      yield* turns.pause(assistant.id);

      expect(yield* stopOf(paused.stopped)).toEqual(Option.some("Paused"));
      expect(yield* stopOf(other.stopped)).toEqual(Option.none());
      expect((yield* trail).slice(-2)).toEqual([
        "turn.stopped · allow | person | assistant | bot paused",
        "turn.stopped · succeeded | person",
      ]);
    }).pipe(Effect.provide(server())),
  );

  it.effect(
    "stops a turn once when the person presses Stop twice, and records who stopped it",
    () =>
      Effect.gen(function* () {
        const turns = yield* Turns;
        const claim = yield* turns.start(first, assistant.id);

        yield* turns.stop(first);
        yield* turns.stop(first);
        yield* turns.stop(second);

        expect(yield* stopOf(claim.stopped)).toEqual(Option.some("Person"));
        expect(yield* trail).toEqual([
          "turn.stopped · allow | person | assistant | stopped by the person",
          "turn.stopped · succeeded | person",
        ]);
      }).pipe(Effect.provide(server())),
  );

  it.effect("frees the conversation when the turn's scope closes", () =>
    Effect.gen(function* () {
      const turns = yield* Turns;

      yield* Effect.scoped(turns.start(first, assistant.id));

      expect(yield* turns.isRunning(first)).toBe(false);
      yield* turns.start(first, assistant.id);
      expect(yield* turns.isRunning(first)).toBe(true);
      expect((yield* turns.start(first, assistant.id).pipe(Effect.flip))._tag).toBe(
        "ConversationBusy",
      );
    }).pipe(Effect.provide(server())),
  );

  describe("when the pause state cannot be read", () => {
    it.effect("keeps a turn whose check failed twice and then read again", () => {
      const failures = Ref.makeUnsafe(0);

      return Effect.gen(function* () {
        const turns = yield* Turns;
        const claim = yield* turns.start(first, assistant.id);
        yield* firstCheck(turns);

        yield* Ref.set(failures, 2);
        yield* TestClock.adjust("15 seconds");

        expect(yield* stopOf(claim.stopped)).toEqual(Option.none());

        yield* Ref.set(failures, 2);
        yield* TestClock.adjust("10 seconds");

        expect(yield* stopOf(claim.stopped)).toEqual(Option.none());
      }).pipe(Effect.provide(server(failures)));
    });

    it.effect("stops a running turn after three checks in a row could not read it", () => {
      const failures = Ref.makeUnsafe(0);

      return Effect.gen(function* () {
        const turns = yield* Turns;
        const claim = yield* turns.start(first, assistant.id);
        yield* firstCheck(turns);

        yield* Ref.set(failures, 3);
        yield* TestClock.adjust("10 seconds");
        expect(yield* stopOf(claim.stopped)).toEqual(Option.none());

        yield* TestClock.adjust("5 seconds");
        expect(yield* stopOf(claim.stopped)).toEqual(Option.some("PauseUnknown"));
        expect(yield* trail).toEqual([
          "turn.stopped · allow | deployment | assistant | pause state unreadable",
          "turn.stopped · succeeded | deployment",
        ]);
      }).pipe(Effect.provide(server(failures)));
    });
  });
});

describe("Pause RPCs", () => {
  it.effect(
    "streams the paused Bots as they change, and refuses a Bot the server does not know",
    () =>
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(PauseRpcs);

        const seen = yield* client["Pause.watch"]().pipe(
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* TestClock.adjust("1 second");
        yield* client["Pause.pause"]({ botId: assistant.id });
        yield* client["Pause.resume"]({ botId: assistant.id });

        expect(yield* Fiber.join(seen)).toEqual([[], [assistant.id], []]);

        const unknown = BotId.make("nobody");
        expect(yield* client["Pause.pause"]({ botId: unknown }).pipe(Effect.flip)).toEqual(
          new UnknownBot({ botId: unknown }),
        );
      }).pipe(Effect.provide(pauseHandlers.pipe(Layer.provide([server(), testBots])))),
  );
});
