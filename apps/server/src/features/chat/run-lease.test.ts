import { ConversationBusy, ConversationId, RunId } from "@aobot/domain";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Scope } from "effect";
import { TestClock } from "effect/testing";
import { holdLease, RunLease, runLeaseLayer } from "./run-lease.ts";
import { testDatabase } from "./testing/test-database.ts";

const conversation = ConversationId.make("conversation-1");

const first = RunId.make("run-1");

const second = RunId.make("run-2");

const leases = runLeaseLayer.pipe(Layer.provide(testDatabase));

function advanceSeconds(seconds: number) {
  return Effect.forEach(Array.from({ length: seconds }), () => TestClock.adjust("1 second"), {
    discard: true,
  });
}

describe("RunLease", () => {
  it.effect("lets a crashed run's lease expire after 120 seconds", () =>
    Effect.gen(function* () {
      const lease = yield* RunLease;

      expect(yield* lease.acquire(conversation, first)).toBe(true);
      expect(yield* lease.acquire(conversation, second)).toBe(false);

      yield* TestClock.adjust("119 seconds");
      expect(yield* lease.acquire(conversation, second)).toBe(false);
      expect(yield* lease.isHeld(conversation)).toBe(true);

      yield* TestClock.adjust("1 second");
      expect(yield* lease.isHeld(conversation)).toBe(false);
      expect(yield* lease.acquire(conversation, second)).toBe(true);
    }).pipe(Effect.provide(leases)),
  );

  it.effect("keeps a held lease alive with its heartbeat and frees it when the run ends", () =>
    Effect.gen(function* () {
      const lease = yield* RunLease;
      const run = yield* Scope.make();

      yield* holdLease(conversation, first).pipe(Scope.provide(run));
      yield* advanceSeconds(10 * 60);

      const refused = yield* Effect.flip(Effect.scoped(holdLease(conversation, second)));
      expect(refused).toEqual(new ConversationBusy({ conversationId: conversation }));

      yield* Scope.close(run, Exit.void);
      expect(yield* lease.isHeld(conversation)).toBe(false);
      expect(yield* lease.acquire(conversation, second)).toBe(true);
    }).pipe(Effect.provide(leases)),
  );
});
