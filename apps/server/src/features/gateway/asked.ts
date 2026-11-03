import { Effect, type Equivalence, HashMap, Option, Stream, SubscriptionRef } from "effect";
import { actorId, CurrentActor } from "../../shared/actor.ts";

/** Something a Bot asked its person, in the turn of the person whose `actorId` is `asker`. */
export interface Asked {
  readonly asker: string;
}

/** Whether `asked` was asked of the person whose `actorId` is `person`: only they see and answer it. */
export const askedOf =
  (person: string) =>
  (asked: Asked): boolean =>
    asked.asker === person;

/**
What `waiting` holds at `key` for the {@link CurrentActor} to see, as `shown` draws it: now, then each
change. Something asked of anyone else shows as none.
*/
export function shownToCaller<K, W extends Asked, A>(
  waiting: SubscriptionRef.SubscriptionRef<HashMap.HashMap<K, W>>,
  key: (caller: string) => K,
  shown: (asked: W) => Option.Option<A>,
  same: Equivalence.Equivalence<A>,
): Stream.Stream<Option.Option<A>> {
  return Stream.unwrap(
    Effect.map(CurrentActor, (actor) => {
      const caller = actorId(actor);

      return SubscriptionRef.changes(waiting).pipe(
        Stream.map((all) =>
          Option.flatMap(Option.filter(HashMap.get(all, key(caller)), askedOf(caller)), shown),
        ),
        Stream.changesWith(Option.makeEquivalence(same)),
      );
    }),
  );
}
