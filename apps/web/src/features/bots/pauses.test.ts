import { BotId, PauseNotChanged, PauseRpcs } from "@aobot/domain";
import { Effect, Layer, Option, Stream, SubscriptionRef } from "effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { RpcTest } from "effect/rpc";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { PauseClient } from "./pause-client.ts";
import { makePauses } from "./pauses.ts";

const chief = BotId.make("chief");

/** A pause server that keeps the paused Bots in memory, and refuses to resume `stuck`. */
function pauseServer(stuck: ReadonlyArray<BotId>) {
  const handlers = PauseRpcs.toLayer(
    Effect.gen(function* () {
      const paused = yield* SubscriptionRef.make<ReadonlyArray<BotId>>([]);

      return PauseRpcs.of({
        "Pause.watch": () => SubscriptionRef.changes(paused),
        "Pause.pause": ({ botId }) =>
          SubscriptionRef.update(paused, (bots) =>
            bots.includes(botId) ? bots : [...bots, botId],
          ),
        "Pause.resume": ({ botId }) =>
          stuck.includes(botId)
            ? Effect.fail(new PauseNotChanged({ message: "The Bot was not resumed." }))
            : SubscriptionRef.update(paused, (bots) => bots.filter((bot) => bot !== botId)),
      });
    }),
  );

  return Atom.runtime(
    Layer.effect(PauseClient, RpcTest.makeClient(PauseRpcs, { flatten: true })).pipe(
      Layer.provide(handlers),
    ),
  );
}

const registries: AtomRegistry.AtomRegistry[] = [];

afterEach(() => {
  registries.splice(0).forEach((registry) => registry.dispose());
});

/** The first value of `atom` that `predicate` accepts. */
function until<A>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<A>,
  predicate: (value: A) => boolean,
): Promise<A> {
  return Atom.toStream(atom).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.provideService(AtomRegistry.AtomRegistry, registry),
    Effect.runPromise,
  );
}

function start(stuck: ReadonlyArray<BotId> = []) {
  const pauses = makePauses(pauseServer(stuck));
  const registry = AtomRegistry.make();
  registries.push(registry);
  registry.mount(pauses.pausedBots);
  registry.mount(pauses.lastChange(chief));

  const pausedNow = (bots: ReadonlyArray<BotId>) =>
    until(registry, pauses.pausedBots, (result) =>
      Option.exists(AsyncResult.value(result), (read) => read.join() === bots.join()),
    );

  const answered = () =>
    until(
      registry,
      pauses.lastChange(chief),
      (last) => !last.waiting && AsyncResult.isSuccess(last),
    );

  return { registry, pauses, pausedNow, answered };
}

describe("given a Bot an admin can pause", () => {
  it("follows the server as the Bot is paused and resumed", async () => {
    const { registry, pauses, pausedNow, answered } = start();

    await pausedNow([]);
    registry.set(pauses.lastChange(chief), "pause");
    await pausedNow([chief]);
    expect(Option.flatten(AsyncResult.value(await answered()))).toEqual(Option.none());

    registry.set(pauses.lastChange(chief), "resume");
    await pausedNow([]);
  });

  it("says why a resume did not happen, and keeps the Bot paused", async () => {
    const { registry, pauses, pausedNow, answered } = start([chief]);

    registry.set(pauses.lastChange(chief), "pause");
    await pausedNow([chief]);
    await answered();

    registry.set(pauses.lastChange(chief), "resume");

    const last = await until(
      registry,
      pauses.lastChange(chief),
      (result) => !result.waiting && Option.isSome(Option.flatten(AsyncResult.value(result))),
    );

    expect(Option.flatten(AsyncResult.value(last))).toEqual(
      Option.some("The Bot was not resumed."),
    );
    await pausedNow([chief]);
  });
});
