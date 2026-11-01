import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Exit, Fiber, Layer, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";
import { Gateway, type Refusal } from "../../gateway/public.ts";
import { AgentEvent, AgentRuntime, Stalled } from "../agent-runtime.ts";
import { type Scenario, contractTurn, transcriptFile } from "../testing/acp-scenarios.ts";
import { decodeTranscript, placeholders } from "../testing/acp-transcript.ts";
import { type Replay, makeReplay } from "../testing/replay-spawner.ts";
import { layerAcp } from "./acp-runtime.ts";
import { type AcpAgentName, acpAgents } from "./launchers.ts";

/**
Tier 2 for the `acp` runtime against what each real adapter said: the contract suite recorded these
turns (`vp run test:contract:agents:record`), and here they play back in-process, on the test clock, in
milliseconds. A changed message from our client, or an adapter version bump without a new recording,
shows up as a replay problem.
*/

const stallTimeout = Duration.seconds(90);

const agents = ["claude-code", "codex", "opencode"] as const satisfies ReadonlyArray<AcpAgentName>;

function transcript(scenario: Scenario, agent: AcpAgentName) {
  return decodeTranscript(readFileSync(transcriptFile(scenario, agent), "utf8"));
}

function runtimeFor(agent: AcpAgentName, replay: Replay) {
  const refusals: Array<Refusal> = [];

  const gateway = Layer.succeed(
    Gateway,
    Gateway.of({ refuse: (refusal) => Effect.sync(() => void refusals.push(refusal)) }),
  );

  const layer = layerAcp({
    agent,
    launcher: acpAgents[agent],
    home: tmpdir(),
    gatewayMcpUrl: placeholders.gateway,
    stallTimeout,
  }).pipe(
    Layer.provide([gateway, replay.layer]),
    Layer.provide([NodeFileSystem.layer, NodePath.layer]),
  );

  return { layer, refusals };
}

const runTurn = Effect.gen(function* () {
  const agent = yield* AgentRuntime;

  return yield* Stream.runCollect(agent.run(contractTurn));
});

function textOf(events: ReadonlyArray<AgentEvent>): string {
  return events
    .flatMap((event) => (AgentEvent.$is("TextDelta")(event) ? [event.text] : []))
    .join("");
}

describe.each(agents)("the acp runtime replaying %s", (agent) => {
  it.effect("streams the answer in pieces, then done", () =>
    Effect.gen(function* () {
      const replay = yield* makeReplay(transcript("streams", agent));
      const events = yield* runTurn.pipe(Effect.provide(runtimeFor(agent, replay).layer));

      expect(yield* replay.problems).toEqual([]);
      expect(textOf(events)).toContain("Hi there, friend");
      expect(events.filter(AgentEvent.$is("TextDelta")).length).toBeGreaterThan(1);
      expect(events.at(-1)).toEqual(AgentEvent.Done());
    }),
  );

  it.effect("sends session/cancel when the turn is stopped mid-answer", () =>
    Effect.gen(function* () {
      const replay = yield* makeReplay(transcript("cancel", agent));

      const exit = yield* Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const seen = yield* Queue.unbounded<AgentEvent>();

        const fiber = yield* runtime.run(contractTurn).pipe(
          Stream.runForEach((event) => Queue.offer(seen, event)),
          Effect.forkChild,
        );

        yield* Queue.take(seen).pipe(Effect.repeat({ until: AgentEvent.$is("TextDelta") }));

        return yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)));
      }).pipe(Effect.provide(runtimeFor(agent, replay).layer));

      expect(Exit.hasInterrupts(exit)).toBe(true);
      expect(yield* replay.problems).toEqual([]);
      expect(yield* replay.sent).toContain("session/cancel");
    }),
  );

  it.effect("answers without asking the gateway when the model calls switched-off tools", () =>
    Effect.gen(function* () {
      const replay = yield* makeReplay(transcript("escape", agent));
      const runtime = runtimeFor(agent, replay);
      const events = yield* runTurn.pipe(Effect.provide(runtime.layer));

      expect(yield* replay.problems).toEqual([]);
      expect(textOf(events)).toContain("All done.");
      expect(runtime.refusals).toEqual([]);
    }),
  );
});

describe("the acp runtime held at a replay gate", () => {
  // The answer to `session/prompt`, which is our third request (0 initialize, 1 session/new).
  const promptAnswer = "answer:2";

  /** Start the turn in the background, its events going into a queue the test reads. */
  const startTurn = (replay: Replay) =>
    Effect.gen(function* () {
      const seen = yield* Queue.unbounded<AgentEvent>();

      const fiber = yield* Effect.gen(function* () {
        const runtime = yield* AgentRuntime;

        yield* Stream.runForEach(runtime.run(contractTurn), (event) => Queue.offer(seen, event));
      }).pipe(Effect.provide(runtimeFor("claude-code", replay).layer), Effect.forkChild);

      return { seen, fiber };
    });

  /** Read events until their text holds `text`, and return what was read. */
  const readUntil = (seen: Queue.Queue<AgentEvent>, text: string) =>
    Effect.gen(function* () {
      const read: Array<AgentEvent> = [];

      while (!textOf(read).includes(text)) read.push(yield* Queue.take(seen));

      return read;
    });

  it.effect("has streamed every word but not finished before the adapter answers the prompt", () =>
    Effect.gen(function* () {
      const replay = yield* makeReplay(transcript("streams", "claude-code"), [promptAnswer]);
      const { seen, fiber } = yield* startTurn(replay);

      yield* replay.reached(promptAnswer);
      const before = yield* readUntil(seen, "Hi there, friend");

      expect(before.some(AgentEvent.$is("Done"))).toBe(false);

      yield* replay.release(promptAnswer);
      yield* Fiber.join(fiber);

      expect(yield* Queue.takeAll(seen)).toEqual([AgentEvent.Done()]);
      expect(yield* replay.problems).toEqual([]);
    }),
  );

  it.effect("fails with Stalled and cancels the session when the answer never comes", () =>
    Effect.gen(function* () {
      const replay = yield* makeReplay(transcript("streams", "claude-code"), [promptAnswer]);
      const { seen, fiber } = yield* startTurn(replay);

      yield* replay.reached(promptAnswer);
      yield* readUntil(seen, "Hi there, friend");

      // The stall timer is armed on each read, so step the test clock until the turn gives up.
      const exit = yield* Effect.raceFirst(
        Fiber.await(fiber),
        TestClock.adjust("1 second").pipe(Effect.forever),
      );

      expect(exit).toEqual(Exit.fail(new Stalled({ waitedMs: Duration.toMillis(stallTimeout) })));
      expect(yield* replay.sent).toContain("session/cancel");
    }),
  );
});
