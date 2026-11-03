import {
  ComputerNotStarted,
  type Control,
  ControlNotChanged,
  InputFailed,
  NotInControl,
  type PersonInput,
} from "@aobot/domain";
import {
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
import { auditRows } from "../audit/public.ts";
import { Computers } from "../computers/public.ts";
import { capText } from "../../shared/tool-result.ts";
import { controlStore } from "./control-store.ts";
import { close, Door, drained, enter, inFlight, leave, reopen, view } from "./door.ts";
import { computerMessageLimit } from "./computer-failure.ts";
import { snapshotStore } from "./snapshot-store.ts";
import { spanEvent } from "./span-event.ts";

/**
A person taking the computer, clicking on its screen, and handing it back. Every Bot shares the one
computer until E3-3 gives each person their own, so a person who holds it holds it for every Bot.
*/
export class ComputerControl extends Context.Service<
  ComputerControl,
  {
    /**
    A person takes the computer. Answers once every Bot action already running is done, so the person
    never shares the screen with one, and once the computer runs. Taking what the person already holds
    changes nothing, but starts the computer if none runs. A computer that does not start leaves the
    person holding it.
    */
    readonly take: Effect.Effect<Control, ControlNotChanged | ComputerNotStarted>;
    /** The person hands the computer back to the Bots, which must read the page again before they act on it. */
    readonly handBack: Effect.Effect<Control, ControlNotChanged>;
    /** What the person in control did on the running computer. Not audited. */
    readonly input: (input: PersonInput) => Effect.Effect<void, NotInControl | InputFailed>;
    /** Who holds the computer: now, then each change. */
    readonly watch: Stream.Stream<Control>;
  }
>()("aobot/gateway/ComputerControl") {}

/** A Bot action turned away at the door: a person holds the computer, or is taking it. */
export class PersonHasControl extends Schema.TaggedError<PersonHasControl>()(
  "PersonHasControl",
  {},
) {}

/** How long a person's input may take before the person is told it failed. */
const inputTimeLimit = "15 seconds";

function inputFailed(error: { readonly message: string }) {
  return new InputFailed({ message: capText(error.message, computerMessageLimit) });
}

function notStarted(error: { readonly message: string }) {
  return new ComputerNotStarted({
    message: `You have control, but the computer could not be started: ${capText(error.message, computerMessageLimit)}`,
  });
}

const notRecorded = new ControlNotChanged({
  message: "Control did not change: it could not be recorded, and nothing changes unrecorded.",
});

const notStored = new ControlNotChanged({
  message: "Control did not change: who holds the computer could not be stored.",
});

/**
The computer's door in the gateway, and what a person does with the computer. `door` is what every Bot
action goes through; `handover` lets one change of hands, or one input, happen at a time; `commands` is the
queue commands wait in, one at a time, since they share one shell. Who holds the computer is stored, and
read once here: one server process owns the database (architecture.md, "Local now, AWS later").
*/
export const controlDoors = Effect.gen(function* () {
  const rows = yield* auditRows("person");
  const computers = yield* Computers;
  const sql = yield* SqlClient.SqlClient;
  const store = yield* controlStore;
  const snapshots = yield* snapshotStore;

  const door = yield* SubscriptionRef.make<Door>(
    Option.match(yield* store.held, {
      onNone: () => Door.Open({ inFlight: 0 }),
      onSome: (since) => Door.Held({ since }),
    }),
  );

  const handover = yield* Semaphore.make(1);
  const commands = yield* Semaphore.make(1);

  /**
  `effect` as one action through the door, or `PersonHasControl` when the door is not open. Every Bot
  action comes here, whatever its tool and whichever Bot asks, so none can skip it.
  */
  const admit = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | PersonHasControl, R> =>
    Effect.acquireUseRelease(
      SubscriptionRef.modify(door, enter),
      (admission): Effect.Effect<A, E | PersonHasControl, R> =>
        admission === "admitted" ? effect : Effect.fail(new PersonHasControl()),
      (admission) => (admission === "admitted" ? SubscriptionRef.update(door, leave) : Effect.void),
    );

  /**
  A command through the door once the one before it is done, since they share one shell. It waits outside
  the door, so a take never waits on the queue and one whose turn comes while a person holds the computer
  is refused. Cut off while it waits, it runs `leftQueue` instead, as `effect`, which records what became
  of it, never started.
  */
  const queue = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    leftQueue: Effect.Effect<void>,
  ): Effect.Effect<A, E | PersonHasControl, R> =>
    Effect.suspend(() => {
      let waiting = true;

      return commands
        .withPermits(1)(
          Effect.suspend(() => {
            waiting = false;

            return admit(effect);
          }),
        )
        .pipe(Effect.onInterrupt(() => (waiting ? leftQueue : Effect.void)));
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
  const take = Effect.gen(function* () {
    const held = yield* handover
      .withPermits(1)(
        Effect.gen(function* () {
          const before = yield* SubscriptionRef.get(door);

          if (!Door.$is("Open")(before)) return view(before);

          const allowRow = yield* recordChange("control_taken");
          const waitedFor = inFlight(yield* SubscriptionRef.updateAndGet(door, close));
          yield* spanEvent("control.door_closed", { "control.in_flight": waitedFor });

          const since = yield* DateTime.now;

          yield* store.hold(since).pipe(
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
  }).pipe(Effect.withSpan("ComputerControl.take"));

  /**
  Hands the computer back to the Bots and forgets the latest snapshot, since the person may have changed
  the page: old refs are refused, and a Bot must read the page again before it acts on an element. The
  `succeeded` row commits with the holder and the snapshots, so it is on record exactly when the Bots hold
  the computer again.
  */
  const handBack = handover
    .withPermits(1)(
      Effect.gen(function* () {
        const before = yield* SubscriptionRef.get(door);

        if (!Door.$is("Held")(before)) return view(before);

        const allowRow = yield* recordChange("control_released");

        yield* Effect.all([
          store.release(),
          snapshots.forget,
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
    .pipe(Effect.uninterruptible, Effect.withSpan("ComputerControl.handBack"));

  /**
  A person's input on the screen, only while they hold it, and only on a computer already running:
  starting one is the take's job, and must not hold up a hand back behind the input.
  */
  const input = Effect.fn("ComputerControl.input")(function* (given: PersonInput) {
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

  const watch = SubscriptionRef.changes(door).pipe(Stream.map(view), Stream.changes);

  return {
    admit,
    queue,
    control: ComputerControl.of({ take, handBack, input, watch }),
  };
});
