import { BotId, ConversationId, PauseRpcs, RunId, UnknownBot } from "@aobot/domain";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Ref, Schema, Stream } from "effect";
import { RpcTest } from "effect/rpc";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { assistant, researcher, testBots } from "../bots/testing/test-bots.ts";
import { auditLogLayer, migrateAudit } from "../audit/public.ts";
import { migrateLifecycle } from "./migrations.ts";
import { PauseStore, pauseStoreLayer } from "./pause-store.ts";
import { pauseHandlers } from "./rpcs.ts";
import { testLifecycle } from "./testing/test-lifecycle.ts";
import { LiveTurns, Turns, TurnStopped, turnsLayer } from "./turns.ts";

const first = ConversationId.make("conversation-1");

const second = ConversationId.make("conversation-2");

const run = RunId.make("run-1");

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

/**
Waits until the check of running turns has read the pause state once, as it does when the server starts.
Only before any turn starts: a turn's start reads it too.
*/
const firstCheck = (turns: Turns["Service"]) => Stream.runHead(turns.paused);

/** What stopped a claimed turn, or none while it runs. */
const stopOf = (stopped: Deferred.Deferred<never, TurnStopped>) =>
  Deferred.isDone(stopped).pipe(
    Effect.flatMap((done) =>
      done ? Effect.asSome(Effect.flip(Deferred.await(stopped))) : Effect.succeedNone,
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

        const refused = yield* turns.start(first, run, assistant.id).pipe(Effect.flip);
        expect(refused._tag).toBe("BotPaused");
        expect(yield* turns.isRunning(first)).toBe(false);

        yield* turns.start(second, run, researcher.id);

        yield* turns.resume(assistant.id);
        yield* turns.resume(assistant.id);
        yield* turns.start(first, run, assistant.id);

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
      const paused = yield* turns.start(first, run, assistant.id);
      const other = yield* turns.start(second, run, researcher.id);

      yield* turns.pause(assistant.id);

      expect(yield* stopOf(paused.stopped)).toEqual(
        Option.some(new TurnStopped({ code: "paused", by: "person" })),
      );
      expect(yield* stopOf(other.stopped)).toEqual(Option.none());
    }).pipe(Effect.provide(server())),
  );

  it.effect("stops the turn in the person's conversation, by the person, and no other", () =>
    Effect.gen(function* () {
      const turns = yield* Turns;
      const claim = yield* turns.start(first, run, assistant.id);
      const other = yield* turns.start(second, run, assistant.id);

      yield* turns.stop(first);
      yield* turns.stop(first);

      expect(yield* stopOf(claim.stopped)).toEqual(
        Option.some(new TurnStopped({ code: "stopped", by: "person" })),
      );
      expect(yield* stopOf(other.stopped)).toEqual(Option.none());
    }).pipe(Effect.provide(server())),
  );

  it.effect("says a turn runs until it is stopped or ends, and only for its own run", () =>
    Effect.gen(function* () {
      const turns = yield* Turns;
      const live = yield* LiveTurns;

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* turns.start(first, run, assistant.id);
          yield* turns.start(second, run, assistant.id);

          expect(yield* live.live(first, run)).toBe(true);
          expect(yield* live.live(first, RunId.make("run-2"))).toBe(false);

          const stopped = yield* Effect.forkChild(live.stopped(first, run));
          yield* turns.stop(first);

          yield* Fiber.join(stopped);
          expect(yield* live.live(first, run)).toBe(false);
        }),
      );

      expect(yield* live.live(second, run)).toBe(false);
      yield* live.stopped(second, run);
    }).pipe(Effect.provide(server())),
  );

  it.effect(
    "refuses a turn paused between its claim and its read, which never ran and so was never stopped",
    () => {
      const reading = Deferred.makeUnsafe<void>();
      const answer = Deferred.makeUnsafe<void>();
      const reads = Ref.makeUnsafe(0);

      // The server's first read is its check at start-up; the second is the turn's.
      const heldSecondRead = Layer.effect(
        PauseStore,
        Effect.gen(function* () {
          const store = yield* PauseStore;

          const paused = Ref.getAndUpdate(reads, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1
                ? Deferred.succeed(reading, undefined).pipe(
                    Effect.andThen(Deferred.await(answer)),
                    Effect.andThen(store.paused),
                  )
                : store.paused,
            ),
          );

          return PauseStore.of({ ...store, paused });
        }),
      ).pipe(Layer.provide(pauseStoreLayer));

      const held = turnsLayer.pipe(
        Layer.provide([heldSecondRead, auditLogLayer]),
        Layer.provide(Layer.effectDiscard(Effect.all([migrateLifecycle, migrateAudit]))),
        Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
      );

      return Effect.gen(function* () {
        const turns = yield* Turns;
        yield* firstCheck(turns);

        const starting = yield* Effect.scoped(turns.start(first, run, assistant.id)).pipe(
          Effect.flip,
          Effect.forkChild,
        );

        yield* Deferred.await(reading);
        yield* turns.pause(assistant.id);
        yield* Deferred.succeed(answer, undefined);

        expect((yield* Fiber.join(starting))._tag).toBe("BotPaused");
        expect(yield* trail).toEqual([
          "bot.paused · allow | person | assistant",
          "bot.paused · succeeded | person",
          "turn · deny | person | assistant | bot paused",
        ]);
      }).pipe(Effect.provide(held));
    },
  );

  it.effect("frees the conversation when the turn's scope closes", () =>
    Effect.gen(function* () {
      const turns = yield* Turns;

      yield* Effect.scoped(turns.start(first, run, assistant.id));

      expect(yield* turns.isRunning(first)).toBe(false);
      yield* turns.start(first, run, assistant.id);
      expect(yield* turns.isRunning(first)).toBe(true);
      expect((yield* turns.start(first, run, assistant.id).pipe(Effect.flip))._tag).toBe(
        "ConversationBusy",
      );
    }).pipe(Effect.provide(server())),
  );

  describe("when the pause state cannot be read", () => {
    it.effect("keeps a turn whose check failed twice and then read again", () => {
      const failures = Ref.makeUnsafe(0);

      return Effect.gen(function* () {
        const turns = yield* Turns;
        yield* firstCheck(turns);
        const claim = yield* turns.start(first, run, assistant.id);

        yield* Ref.set(failures, 2);
        yield* TestClock.adjust("15 seconds");

        expect(yield* stopOf(claim.stopped)).toEqual(Option.none());

        yield* Ref.set(failures, 2);
        yield* TestClock.adjust("10 seconds");

        expect(yield* stopOf(claim.stopped)).toEqual(Option.none());
      }).pipe(Effect.provide(server(failures)));
    });

    it.effect("counts only failed reads in a row: a turn's start that read clears them", () => {
      const failures = Ref.makeUnsafe(0);

      return Effect.gen(function* () {
        const turns = yield* Turns;
        yield* firstCheck(turns);
        const claim = yield* turns.start(first, run, assistant.id);

        yield* Ref.set(failures, 2);
        yield* TestClock.adjust("10 seconds");
        yield* turns.start(second, run, researcher.id);

        yield* Ref.set(failures, 1);
        yield* TestClock.adjust("5 seconds");

        expect(yield* stopOf(claim.stopped)).toEqual(Option.none());
      }).pipe(Effect.provide(server(failures)));
    });

    it.effect("stops a running turn after three checks in a row could not read it", () => {
      const failures = Ref.makeUnsafe(0);

      return Effect.gen(function* () {
        const turns = yield* Turns;
        yield* firstCheck(turns);
        const claim = yield* turns.start(first, run, assistant.id);

        yield* Ref.set(failures, 3);
        yield* TestClock.adjust("10 seconds");
        expect(yield* stopOf(claim.stopped)).toEqual(Option.none());

        yield* TestClock.adjust("5 seconds");
        expect(yield* stopOf(claim.stopped)).toEqual(
          Option.some(new TurnStopped({ code: "pause_unknown", by: "deployment" })),
        );
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

        yield* Effect.yieldNow;
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
