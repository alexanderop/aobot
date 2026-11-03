import { Effect, Layer, Ref } from "effect";
import { auditLogLayer, migrateAudit } from "../../audit/public.ts";
import { migrateLifecycle } from "../migrations.ts";
import { PauseStore, pauseStoreLayer, PauseUnreadable } from "../pause-store.ts";
import { turnsLayer } from "../turns.ts";

/**
A {@link PauseStore} on the test's database whose reads fail while `failures` is above zero, each failed
read taking one from it, as a database that is locked for a while.
*/
function flakyPauseStore(failures: Ref.Ref<number>) {
  return Layer.effect(
    PauseStore,
    Effect.gen(function* () {
      const store = yield* PauseStore;

      const paused = Ref.modify(failures, (left) => [left, Math.max(0, left - 1)] as const).pipe(
        Effect.flatMap((left) =>
          left > 0
            ? Effect.fail(new PauseUnreadable({ message: "database is locked" }))
            : store.paused,
        ),
      );

      return PauseStore.of({ ...store, paused });
    }),
  ).pipe(Layer.provide(pauseStoreLayer));
}

/**
The lifecycle of one server on the test's SQLite database, with its own audit log and the tables both
need. Pass `failures` to fail the next reads of the pause state.
*/
export function testLifecycle(failures: Ref.Ref<number> = Ref.makeUnsafe(0)) {
  return turnsLayer.pipe(
    Layer.provide([flakyPauseStore(failures), auditLogLayer]),
    Layer.provide(Layer.effectDiscard(Effect.all([migrateLifecycle, migrateAudit]))),
  );
}
