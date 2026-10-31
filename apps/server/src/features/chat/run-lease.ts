import { ConversationBusy, type ConversationId, type RunId } from "@aobot/domain";
import { Clock, Context, Duration, Effect, Layer, Schedule } from "effect";
import { SqlClient } from "effect/sql";

/** How long a lease lasts without a heartbeat, so a crashed server frees its conversations. */
export const leaseTtl = Duration.seconds(120);

const heartbeatEvery = Duration.seconds(40);

function epochSeconds(millis: number): number {
  return millis / 1000;
}

/**
One run per conversation, across every server process. The lease is a row in Postgres that a run takes
atomically, renews while it runs and deletes when it ends. A lease left by a crashed run expires.
*/
export class RunLease extends Context.Service<
  RunLease,
  {
    /** Take the conversation's lease, or take over an expired one. `false` when another run holds it. */
    readonly acquire: (conversationId: ConversationId, runId: RunId) => Effect.Effect<boolean>;
    /** Extend a lease this run holds. `false` when it was lost. */
    readonly renew: (conversationId: ConversationId, runId: RunId) => Effect.Effect<boolean>;
    readonly release: (conversationId: ConversationId, runId: RunId) => Effect.Effect<void>;
    /** Whether some run holds a lease that has not expired. */
    readonly isHeld: (conversationId: ConversationId) => Effect.Effect<boolean>;
  }
>()("aobot/chat/RunLease") {}

/** {@link RunLease} on the app's Postgres, timed by Effect's `Clock` so tests control expiry. */
export const runLeaseLayer = Layer.effect(
  RunLease,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const expiresAt = Effect.map(Clock.currentTimeMillis, (now) => ({
      now: epochSeconds(now),
      expires: epochSeconds(now + Duration.toMillis(leaseTtl)),
    }));

    const acquire = Effect.fn("RunLease.acquire")(function* (
      conversationId: ConversationId,
      runId: RunId,
    ) {
      const { now, expires } = yield* expiresAt;

      const rows = yield* sql`
        INSERT INTO conversation_leases (conversation_id, run_id, expires_at)
        VALUES (${conversationId}, ${runId}, to_timestamp(${expires}::double precision))
        ON CONFLICT (conversation_id) DO UPDATE
          SET run_id = EXCLUDED.run_id, expires_at = EXCLUDED.expires_at
          WHERE conversation_leases.expires_at <= to_timestamp(${now}::double precision)
        RETURNING run_id
      `.pipe(Effect.orDie);

      return rows.length > 0;
    });

    const renew = Effect.fn("RunLease.renew")(function* (
      conversationId: ConversationId,
      runId: RunId,
    ) {
      const { expires } = yield* expiresAt;

      const rows = yield* sql`
        UPDATE conversation_leases SET expires_at = to_timestamp(${expires}::double precision)
        WHERE conversation_id = ${conversationId} AND run_id = ${runId}
        RETURNING run_id
      `.pipe(Effect.orDie);

      return rows.length > 0;
    });

    const release = Effect.fn("RunLease.release")(function* (
      conversationId: ConversationId,
      runId: RunId,
    ) {
      yield* sql`
        DELETE FROM conversation_leases
        WHERE conversation_id = ${conversationId} AND run_id = ${runId}
      `.pipe(Effect.orDie);
    });

    const isHeld = Effect.fn("RunLease.isHeld")(function* (conversationId: ConversationId) {
      const { now } = yield* expiresAt;

      const rows = yield* sql`
        SELECT 1 FROM conversation_leases
        WHERE conversation_id = ${conversationId}
          AND expires_at > to_timestamp(${now}::double precision)
      `.pipe(Effect.orDie);

      return rows.length > 0;
    });

    return RunLease.of({ acquire, renew, release, isHeld });
  }),
);

/**
Hold the conversation's lease for the rest of the current scope: renewed by a heartbeat, released when
the scope closes. Fails with {@link ConversationBusy} when another run holds it.
*/
export const holdLease = Effect.fn("RunLease.hold")(function* (
  conversationId: ConversationId,
  runId: RunId,
) {
  const lease = yield* RunLease;

  yield* Effect.acquireRelease(
    Effect.filterOrFail(
      lease.acquire(conversationId, runId),
      (acquired) => acquired,
      () => new ConversationBusy({ conversationId }),
    ),
    () => lease.release(conversationId, runId),
  );

  const beat = Effect.flatMap(lease.renew(conversationId, runId), (renewed) =>
    renewed
      ? Effect.void
      : Effect.logWarning("A running turn lost its conversation lease").pipe(
          Effect.annotateLogs({ conversationId, runId }),
        ),
  );

  yield* beat.pipe(
    Effect.delay(heartbeatEvery),
    Effect.repeat(Schedule.spaced(heartbeatEvery)),
    Effect.forkScoped,
  );
});
