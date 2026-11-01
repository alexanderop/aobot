import {
  type BotId,
  ComputerNotStarted,
  type Control,
  ControlNotChanged,
  InputFailed,
  NotInControl,
  type PersonInput,
} from "@aobot/domain";
import {
  Cache,
  Context,
  DateTime,
  Effect,
  Option,
  Schema,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import { SqlClient } from "effect/sql";
import { Computers } from "../computers/public.ts";
import { capText } from "../../shared/tool-result.ts";
import { controlStore } from "./control-store.ts";
import { close, Door, drained, enter, inFlight, leave, reopen, view } from "./door.ts";
import { personAudit } from "./person-audit.ts";
import { snapshotStore } from "./snapshot-store.ts";
import { spanEvent } from "./span-event.ts";

/** A person taking a Bot's computer, clicking on its screen, and handing it back. */
export class ComputerControl extends Context.Service<
  ComputerControl,
  {
    /**
    A person takes the Bot's computer. Answers once every Bot action already running is done, so the
    person never shares the screen with one, and once the computer runs. Taking what the person already
    holds changes nothing, but starts the computer if none runs. A computer that does not start leaves
    the person holding it.
    */
    readonly take: (bot: BotId) => Effect.Effect<Control, ControlNotChanged | ComputerNotStarted>;
    /** The person hands the computer back to the Bot, which must read the page again before it acts on it. */
    readonly handBack: (bot: BotId) => Effect.Effect<Control, ControlNotChanged>;
    /** What the person in control did on the Bot's running computer. Not audited. */
    readonly input: (
      bot: BotId,
      input: PersonInput,
    ) => Effect.Effect<void, NotInControl | InputFailed>;
    /** Who holds the Bot's computer: now, then each change. */
    readonly watch: (bot: BotId) => Stream.Stream<Control>;
  }
>()("aobot/gateway/ComputerControl") {}

/** A Bot action turned away at the door: a person holds its computer, or is taking it. */
export class PersonHasControl extends Schema.TaggedError<PersonHasControl>()(
  "PersonHasControl",
  {},
) {}

/**
One Bot's door in the gateway. `door` is what every Bot action goes through; `handover` lets one change
of hands, or one input, happen at a time; `commands` is the queue a Bot's commands wait in, one at a time.
*/
interface BotDoor {
  readonly door: SubscriptionRef.SubscriptionRef<Door>;
  readonly handover: Semaphore.Semaphore;
  readonly commands: Semaphore.Semaphore;
}

/** How long a person's input may take before the person is told it failed. */
const inputTimeLimit = "15 seconds";

/** The longest computer message a person is shown. */
const messageLimit = 500;

function inputFailed(error: { readonly message: string }) {
  return new InputFailed({ message: capText(error.message, messageLimit) });
}

function notStarted(error: { readonly message: string }) {
  return new ComputerNotStarted({
    message: `You have control, but the computer could not be started: ${capText(error.message, messageLimit)}`,
  });
}

const notRecorded = new ControlNotChanged({
  message: "Control did not change: it could not be recorded, and nothing changes unrecorded.",
});

const notStored = new ControlNotChanged({
  message: "Control did not change: who holds the computer could not be stored.",
});

/**
Each Bot's door in the gateway, and what a person does with its computer. Who holds it is stored, and read
once here: one server process owns the database (architecture.md, "Local now, AWS later").
*/
export const controlDoors = Effect.gen(function* () {
  const rows = yield* personAudit;
  const computers = yield* Computers;
  const sql = yield* SqlClient.SqlClient;
  const store = yield* controlStore;
  const snapshots = yield* snapshotStore;

  const heldAtBoot = yield* store.held;

  const doors = yield* Cache.make({
    capacity: Number.POSITIVE_INFINITY,
    lookup: (bot: BotId): Effect.Effect<BotDoor> =>
      Effect.all({
        door: SubscriptionRef.make<Door>(
          Option.match(Option.fromNullishOr(heldAtBoot.get(bot)), {
            onNone: () => Door.Open({ inFlight: 0 }),
            onSome: (since) => Door.Held({ since }),
          }),
        ),
        handover: Semaphore.make(1),
        commands: Semaphore.make(1),
      }),
  });

  /**
  `effect` as one action through the Bot's door, or `PersonHasControl` when the door is not open. Every
  Bot action comes here, whatever its tool, so no tool can skip it. A `queued` action waits for the one
  before it outside the door, so a take never waits on the queue and one whose turn comes while a person
  holds the computer is refused.
  */
  const admit = <A, E, R>(
    bot: BotId,
    effect: Effect.Effect<A, E, R>,
    { queued }: { readonly queued: boolean },
  ): Effect.Effect<A, E | PersonHasControl, R> =>
    Effect.flatMap(Cache.get(doors, bot), ({ door, commands }) => {
      const through = Effect.acquireUseRelease(
        SubscriptionRef.modify(door, enter),
        (admission): Effect.Effect<A, E | PersonHasControl, R> =>
          admission === "admitted" ? effect : Effect.fail(new PersonHasControl()),
        (admission) =>
          admission === "admitted" ? SubscriptionRef.update(door, leave) : Effect.void,
      );

      return queued ? commands.withPermits(1)(through) : through;
    });

  const recordChange = (action: "control_taken" | "control_released") =>
    rows.decide("allow", action, {}).pipe(
      Effect.tapError((error) =>
        Effect.logError("A control row could not be written, so control did not change").pipe(
          Effect.annotateLogs({ action, reason: error.message }),
        ),
      ),
      Effect.mapError(() => notRecorded),
    );

  /**
  Writes the take's row, closes the door, stores the person as the holder, then waits for every action
  already let in to finish. A crash while it waits starts the server again with the person holding.
  Once the door is closed, only reaching `Held` or opening it again may follow, so the change of hands
  cannot be interrupted.
  */
  const take = Effect.fn("ComputerControl.take")(function* (bot: BotId) {
    const { door, handover } = yield* Cache.get(doors, bot);

    const held = yield* handover
      .withPermits(1)(
        Effect.gen(function* () {
          const before = yield* SubscriptionRef.get(door);

          if (!Door.$is("Open")(before)) return view(before);

          const allowRow = yield* recordChange("control_taken");
          const waitedFor = inFlight(yield* SubscriptionRef.updateAndGet(door, close));
          yield* spanEvent("control.door_closed", { "control.in_flight": waitedFor });

          const since = yield* DateTime.now;

          yield* store.hold(bot, since).pipe(
            Effect.tapError((error) =>
              Effect.all([
                SubscriptionRef.update(door, reopen),
                rows.settle(allowRow, "failed", { reason: "not stored", message: error.message }),
              ]),
            ),
            Effect.mapError(() => notStored),
          );

          yield* SubscriptionRef.changes(door).pipe(Stream.filter(drained), Stream.runHead);

          const held = Door.Held({ since });
          yield* SubscriptionRef.set(door, held);
          yield* spanEvent("control.taken");
          yield* rows.settle(allowRow, "succeeded", { waitedFor });

          return view(held);
        }),
      )
      .pipe(Effect.uninterruptible);

    // After a restart nothing runs, and a person holding a computer that shows nothing can click nothing.
    yield* computers.ensure.pipe(Effect.mapError(notStarted));

    return held;
  });

  /**
  Hands the computer back to the Bot and forgets its latest snapshot, so its old refs are refused and it
  must read the page again before it acts on an element. The `succeeded` row commits with the holder and
  the snapshot, so it is on record exactly when the Bot holds its computer again.
  */
  const handBack = Effect.fn("ComputerControl.handBack")(function* (bot: BotId) {
    const { door, handover } = yield* Cache.get(doors, bot);

    return yield* handover
      .withPermits(1)(
        Effect.gen(function* () {
          const before = yield* SubscriptionRef.get(door);

          if (!Door.$is("Held")(before)) return view(before);

          const allowRow = yield* recordChange("control_released");

          yield* Effect.all([
            store.release(bot),
            snapshots.forget(bot),
            rows.outcome(allowRow, "succeeded", {}),
          ]).pipe(
            sql.withTransaction,
            Effect.tapError((error) =>
              rows.settle(allowRow, "failed", { reason: "not stored", message: error.message }),
            ),
            Effect.mapError(() => notStored),
          );

          const open = Door.Open({ inFlight: 0 });
          yield* SubscriptionRef.set(door, open);
          yield* spanEvent("control.released");

          return view(open);
        }),
      )
      .pipe(Effect.uninterruptible);
  });

  /**
  A person's input on the Bot's screen, only while they hold it, and only on a computer already running:
  starting one is the take's job, and must not hold up a hand back behind the input.
  */
  const input = Effect.fn("ComputerControl.input")(function* (bot: BotId, given: PersonInput) {
    const { door, handover } = yield* Cache.get(doors, bot);

    yield* handover
      .withPermits(1)(
        Effect.gen(function* () {
          if (!Door.$is("Held")(yield* SubscriptionRef.get(door))) {
            return yield* new NotInControl({ message: "Take control first." });
          }

          yield* computers.running.pipe(
            Effect.flatMap((computer) => computer.input(given)),
            Effect.mapError(inputFailed),
          );
        }),
      )
      .pipe(
        Effect.timeoutOrElse({
          duration: inputTimeLimit,
          orElse: () =>
            Effect.fail(new InputFailed({ message: "The computer did not answer in time." })),
        }),
      );
  });

  const watch = (bot: BotId): Stream.Stream<Control> =>
    Stream.unwrap(
      Effect.map(Cache.get(doors, bot), ({ door }) => SubscriptionRef.changes(door)),
    ).pipe(Stream.map(view), Stream.changes);

  return { admit, control: ComputerControl.of({ take, handBack, input, watch }) };
});
