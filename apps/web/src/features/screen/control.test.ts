import { ControlRpcs, InputFailed, type ScreenPoint } from "@aobot/domain";
import { Deferred, Effect, Exit, Layer, Option, Stream } from "effect";
import { Atom, AsyncResult, AtomRegistry } from "effect/reactivity";
import { RpcTest } from "effect/rpc";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { ControlClient } from "./control-client.ts";
import { makeControl } from "./control.ts";
import { type Answered, ControlCommand } from "./control-state.ts";

/** A control client whose server does `click` with each click it receives, and nothing else. */
function serverClicking(click: (at: ScreenPoint) => Effect.Effect<void, InputFailed>) {
  const handlers = ControlRpcs.toLayer({
    "Control.watch": () => Stream.never,
    "Control.take": () => Effect.die("unused"),
    "Control.handBack": () => Effect.die("unused"),
    "Control.click": click,
  });

  return Atom.runtime(
    Layer.effect(ControlClient, RpcTest.makeClient(ControlRpcs, { flatten: true })).pipe(
      Layer.provide(handlers),
    ),
  );
}

const registries: AtomRegistry.AtomRegistry[] = [];

afterEach(() => {
  registries.splice(0).forEach((registry) => registry.dispose());
});

/** The answer `lastCommand` settles on once nothing is on its way. */
function answerTo(
  registry: AtomRegistry.AtomRegistry,
  lastCommand: ReturnType<typeof makeControl>["lastCommand"],
): Promise<Answered> {
  return Atom.toStream(lastCommand).pipe(
    Stream.filter((last) => !last.waiting),
    Stream.map(AsyncResult.value),
    Stream.filter(Option.isSome),
    Stream.runHead,
    Effect.map((answer) => Option.getOrThrow(Option.flatten(answer))),
    Effect.provideService(AtomRegistry.AtomRegistry, registry),
    Effect.runPromise,
  );
}

const clickAt = (x: number) => ({
  command: ControlCommand.Click({ at: { x, y: 0.5 } }),
  sentWhile: "Person" as const,
});

describe("given a person in control of the Bot's computer", () => {
  describe("when they click again before the server answered the first click", () => {
    it("sends both clicks in the order made, and answers with the second", async () => {
      const firstHeld = Deferred.makeUnsafe<void>();
      const firstEnded = Deferred.makeUnsafe<"clicked" | "interrupted">();
      const received: Array<number> = [];

      const server = serverClicking((at) =>
        Effect.sync(() => received.push(at.x)).pipe(
          Effect.andThen(
            at.x === 0.25
              ? Deferred.await(firstHeld).pipe(
                  Effect.onExit((exit) =>
                    Deferred.succeed(
                      firstEnded,
                      Exit.hasInterrupts(exit) ? "interrupted" : "clicked",
                    ),
                  ),
                )
              : Effect.fail(new InputFailed({ message: "The page did not answer." })),
          ),
        ),
      );

      const { lastCommand } = makeControl(server);
      const registry = AtomRegistry.make();
      registries.push(registry);
      registry.mount(lastCommand);

      registry.set(lastCommand, clickAt(0.25));
      registry.set(lastCommand, clickAt(0.75));

      const answer = await answerTo(registry, lastCommand);
      expect(Option.map(answer.failure, (failure) => failure.message)).toEqual(
        Option.some("The page did not answer."),
      );

      Deferred.doneUnsafe(firstHeld, Exit.void);

      expect(await Effect.runPromise(Deferred.await(firstEnded))).toBe("clicked");
      expect(received).toEqual([0.25, 0.75]);
    });
  });
});
