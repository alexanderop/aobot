import { CommandEnd, ConversationId, type PageAction, type PageRead, RunId } from "@aobot/domain";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect";
import { CurrentActor } from "../../shared/actor.ts";
import { alice } from "../../shared/testing/people.ts";
import { auditLogLayer } from "../audit/public.ts";
import { assistant, testBots } from "../bots/testing/test-bots.ts";
import { Turns } from "../lifecycle/public.ts";
import { testLifecycle } from "../lifecycle/testing/test-lifecycle.ts";
import { allowEverything } from "../policy/testing/test-policy.ts";
import { Claim, Gateway, gatewayLayer } from "./gateway.ts";
import { auditRows, database, fakeComputers } from "./testing/test-gateway.ts";

const conversation = ConversationId.make("conversation-1");

const run = RunId.make("run-1");

const inTurn = Claim.cases.Named.make({ bot: assistant.id, turn: { conversation, run } });

const otherConversation = ConversationId.make("conversation-2");

const inOtherTurn = Claim.cases.Named.make({
  bot: assistant.id,
  turn: { conversation: otherConversation, run },
});

const navigate = { action: "navigate", url: "https://example.com" } as const;

const sleep = { action: "run", command: "sleep 600" } as const;

const ls = { action: "run", command: "ls" } as const;

const exampleDomain = (action: PageAction): Effect.Effect<PageRead> =>
  Effect.succeed({
    action: action.action,
    url: "https://example.com/",
    title: "Example Domain",
    snapshot: '- heading "Example Domain" [level=1] [ref=e1]',
    truncated: false,
  });

/** Each audit row as `action · decision`, with the reason its detail gives, oldest first. */
const trail = Effect.map(auditRows, (rows) =>
  rows.map((row) => [
    `${String(row["action"])} · ${String(row["decision"])}`,
    JSON.parse(String(row["detail"])).reason,
  ]),
);

/** A gateway on `computers` that reads whether a turn runs from the lifecycle the test starts turns on. */
function withTurns(computers: ReturnType<typeof fakeComputers>) {
  return gatewayLayer.pipe(
    Layer.provide([auditLogLayer, computers.layer, testBots, allowEverything]),
    Layer.provideMerge(testLifecycle()),
  );
}

describe("given a turn the person stopped", () => {
  it.effect("refuses the next call made in it before anything else, as a deny row", () => {
    const computer = fakeComputers({ browse: exampleDomain });

    return Effect.gen(function* () {
      const turns = yield* Turns;
      const gateway = yield* Gateway;
      yield* turns.start(conversation, run, assistant.id, alice);

      yield* gateway.act(inTurn, navigate);
      yield* turns.stop(conversation);
      const refused = yield* gateway.act(inTurn, navigate).pipe(Effect.flip);

      expect(refused.message).toBe(
        "navigate did not run: your turn has ended, so nothing more runs in it. Stop calling tools.",
      );
      expect(computer.actions).toEqual([navigate]);
      expect(yield* trail).toEqual([
        ["navigate · allow", undefined],
        ["navigate · succeeded", undefined],
        ["navigate · deny", "turn ended"],
      ]);
    }).pipe(
      Effect.provide(withTurns(computer)),
      Effect.provide(database),
      Effect.provideService(CurrentActor, alice),
    );
  });

  it.effect("cuts off a call still running in it, whose outcome is then unknown", () => {
    const reached = Deferred.makeUnsafe<void>();

    const computer = fakeComputers({
      browse: () => Effect.andThen(Deferred.succeed(reached, undefined), Effect.never),
    });

    return Effect.gen(function* () {
      const turns = yield* Turns;
      const gateway = yield* Gateway;
      yield* turns.start(conversation, run, assistant.id, alice);

      const acting = yield* gateway.act(inTurn, navigate).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(reached);
      yield* turns.stop(conversation);

      expect((yield* Fiber.join(acting)).message).toBe(
        "navigate was cut off: the turn was stopped.",
      );
      expect(yield* trail).toEqual([
        ["navigate · allow", undefined],
        ["navigate · unknown", "the turn was stopped"],
      ]);
    }).pipe(
      Effect.provide(withTurns(computer)),
      Effect.provide(database),
      Effect.provideService(CurrentActor, alice),
    );
  });
});

describe("given a command waiting for one from another turn", () => {
  it.effect("refuses it at once when its turn is stopped, as a deny row", () => {
    const reached = Deferred.makeUnsafe<void>();

    const computer = fakeComputers({
      run: () => Effect.andThen(Deferred.succeed(reached, undefined), Effect.never),
    });

    return Effect.gen(function* () {
      const turns = yield* Turns;
      const gateway = yield* Gateway;
      yield* turns.start(otherConversation, run, assistant.id, alice);
      yield* turns.start(conversation, run, assistant.id, alice);

      yield* Effect.forkChild(gateway.act(inOtherTurn, sleep));
      yield* Deferred.await(reached);

      const waiting = yield* Effect.forkChild(Effect.flip(gateway.act(inTurn, ls)), {
        startImmediately: true,
      });

      yield* turns.stop(conversation);

      expect((yield* Fiber.join(waiting)).message).toBe("run was cut off: the turn was stopped.");
      expect(computer.actions).toEqual([sleep]);
      expect(yield* trail).toEqual([
        ["run · allow", undefined],
        ["run · deny", "turn ended"],
      ]);
    }).pipe(
      Effect.provide(withTurns(computer)),
      Effect.provide(database),
      Effect.provideService(CurrentActor, alice),
    );
  });

  it.effect("refuses it, once the door lets it in, when its turn ended meanwhile", () => {
    const reached = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();

    const computer = fakeComputers({
      run: (command) =>
        Deferred.succeed(reached, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as({
            action: "run",
            end: CommandEnd.cases.Exited.make({ code: 0 }),
            stdout: { text: command.command, truncated: false },
            stderr: { text: "", truncated: false },
            leftOutputOpen: false,
          } as const),
        ),
    });

    return Effect.gen(function* () {
      const turns = yield* Turns;
      const gateway = yield* Gateway;
      const turn = yield* Scope.make();
      yield* turns.start(otherConversation, run, assistant.id, alice);
      yield* Scope.provide(turns.start(conversation, run, assistant.id, alice), turn);

      const first = yield* Effect.forkChild(gateway.act(inOtherTurn, sleep));
      yield* Deferred.await(reached);

      const waiting = yield* Effect.forkChild(Effect.flip(gateway.act(inTurn, ls)), {
        startImmediately: true,
      });

      yield* Scope.close(turn, Exit.void);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);

      expect((yield* Fiber.join(waiting)).message).toBe(
        "run did not run: your turn has ended, so nothing more runs in it. Stop calling tools.",
      );
      expect(computer.actions).toEqual([sleep]);
      expect(yield* trail).toEqual([
        ["run · allow", undefined],
        ["run · succeeded", undefined],
        ["run · deny", "turn ended"],
      ]);
    }).pipe(
      Effect.provide(withTurns(computer)),
      Effect.provide(database),
      Effect.provideService(CurrentActor, alice),
    );
  });
});
