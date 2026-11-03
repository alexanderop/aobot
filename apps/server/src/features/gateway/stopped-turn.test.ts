import { ConversationId, type PageAction, type PageRead, RunId } from "@aobot/domain";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
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

const navigate = { action: "navigate", url: "https://example.com" } as const;

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
      yield* turns.start(conversation, run, assistant.id);

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
    }).pipe(Effect.provide(withTurns(computer)), Effect.provide(database));
  });

  it.effect("cuts off a call still running in it, whose outcome is then unknown", () => {
    const reached = Deferred.makeUnsafe<void>();

    const computer = fakeComputers({
      browse: () => Effect.andThen(Deferred.succeed(reached, undefined), Effect.never),
    });

    return Effect.gen(function* () {
      const turns = yield* Turns;
      const gateway = yield* Gateway;
      yield* turns.start(conversation, run, assistant.id);

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
    }).pipe(Effect.provide(withTurns(computer)), Effect.provide(database));
  });
});
