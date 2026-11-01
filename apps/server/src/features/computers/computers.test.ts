import type { IncomingHttpHeaders } from "node:http";
import { CommandEnd, PersonInput, Screen, ScreenFrame } from "@aobot/domain";
import { NodeWS } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Array as Arr,
  type Duration,
  Effect,
  Fiber,
  Logger,
  LogLevel,
  Option,
  Redacted,
  Schedule,
  type Schema,
  Stream,
  SubscriptionRef,
} from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import {
  ComputerActFailed,
  type ComputerAddress,
  ComputerLost,
  computerAt,
  liveScreen,
} from "./computers.ts";
import { reply, serve, serveScreen } from "./testing/serve.ts";

/** A computer that answers every request with `status` and `json`, and keeps the headers and paths it was sent. */
function fakeComputer(status: number, json?: Schema.Json) {
  const seen: Array<IncomingHttpHeaders> = [];
  const paths: Array<string | undefined> = [];

  return serve((request, response) => {
    seen.push(request.headers);
    paths.push(request.url);
    reply(response, status, json);
  }).pipe(Effect.map(({ port }) => ({ url: `http://127.0.0.1:${port}`, seen, paths })));
}

const token = Redacted.make("computer-token");

function act(url: string) {
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;

    return yield* computerAt({ url, token }, client).browse({ action: "snapshot" });
  }).pipe(Effect.provide(FetchHttpClient.layer));
}

function runCommand(url: string) {
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;

    return yield* computerAt({ url, token }, client).run({ action: "run", command: "ls" });
  }).pipe(Effect.provide(FetchHttpClient.layer));
}

function click(url: string) {
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;

    return yield* computerAt({ url, token }, client).input(
      PersonInput.cases.Click.make({ at: { x: 0.5, y: 0.5 } }),
    );
  }).pipe(Effect.provide(FetchHttpClient.layer));
}

describe("computerAt", () => {
  it.effect("sends the token and the caller's trace, and reads the result", () =>
    Effect.gen(function* () {
      const computer = yield* fakeComputer(200, {
        action: "snapshot",
        url: "https://example.com/",
        title: "Example Domain",
        snapshot: '- heading "Example Domain" [ref=e1]',
        truncated: false,
      });

      const [result, traceId] = yield* Effect.all([act(computer.url), Effect.currentSpan]).pipe(
        Effect.map(([answer, span]) => [answer, span.traceId] as const),
        Effect.withSpan("Gateway.act"),
      );

      expect(result).toMatchObject({ action: "snapshot", title: "Example Domain" });
      expect(computer.seen[0]?.authorization).toBe("Bearer computer-token");
      expect(computer.seen[0]?.traceparent).toMatch(
        new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`, "u"),
      );
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    [403, "refused"],
    [502, "failed"],
  ] as const)("reads status %i as the computer saying it did not do it", ([status, reason]) =>
    Effect.gen(function* () {
      const computer = yield* fakeComputer(status, { reason, message: "no" });

      expect(yield* Effect.flip(act(computer.url))).toEqual(
        new ComputerActFailed({ reason, message: "no" }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("reads a token the computer turned away as refused: it never tried", () =>
    Effect.gen(function* () {
      const computer = yield* fakeComputer(401, { message: "token" });

      expect(yield* Effect.flip(act(computer.url))).toMatchObject({ reason: "refused" });
    }).pipe(Effect.scoped),
  );

  it.effect("reads a crash or a reply it cannot read as not knowing whether it happened", () =>
    Effect.gen(function* () {
      const crashed = yield* fakeComputer(500, { message: "boom" });
      const garbled = yield* fakeComputer(200, { nothing: "useful" });

      expect(yield* Effect.flip(act(crashed.url))).toBeInstanceOf(ComputerLost);
      expect(yield* Effect.flip(act(garbled.url))).toBeInstanceOf(ComputerLost);
    }).pipe(Effect.scoped),
  );

  it.effect("sends a person's input to /input with the token, and reads 204 as done", () =>
    Effect.gen(function* () {
      const computer = yield* fakeComputer(204);

      yield* click(computer.url);

      expect(computer.paths).toEqual(["/input"]);
      expect(computer.seen[0]?.authorization).toBe("Bearer computer-token");
    }).pipe(Effect.scoped),
  );

  it.effect("reads an input the browser failed as failed, and any other answer as unknown", () =>
    Effect.gen(function* () {
      const failed = yield* fakeComputer(502, { reason: "failed", message: "no page" });
      const page = yield* fakeComputer(200, { action: "snapshot" });

      expect(yield* Effect.flip(click(failed.url))).toEqual(
        new ComputerActFailed({ reason: "failed", message: "no page" }),
      );
      expect(yield* Effect.flip(click(page.url))).toBeInstanceOf(ComputerLost);
    }).pipe(Effect.scoped),
  );

  it.effect("reads an answer in the shape of another action's as not knowing what happened", () =>
    Effect.gen(function* () {
      const page = yield* fakeComputer(200, {
        action: "snapshot",
        url: "https://example.com/",
        title: "Example Domain",
        snapshot: '- heading "Example Domain" [ref=e1]',
        truncated: false,
      });

      const command = yield* fakeComputer(200, {
        action: "run",
        end: CommandEnd.cases.Exited.make({ code: 0 }),
        stdout: { text: "", truncated: false },
        stderr: { text: "", truncated: false },
        leftOutputOpen: false,
      });

      expect(yield* Effect.flip(runCommand(page.url))).toBeInstanceOf(ComputerLost);
      expect(yield* Effect.flip(act(command.url))).toBeInstanceOf(ComputerLost);
      expect(yield* runCommand(command.url)).toMatchObject({ action: "run" });
    }).pipe(Effect.scoped),
  );
});

/** Polls `holds` until it is true, or fails after five seconds. */
function until(what: string, holds: () => boolean) {
  return Effect.suspend(() => (holds() ? Effect.void : Effect.fail(what))).pipe(
    Effect.retry({ times: 250, schedule: Schedule.spaced("20 millis") }),
    Effect.orDie,
  );
}

function screenOf(
  running: SubscriptionRef.SubscriptionRef<Option.Option<ComputerAddress>>,
  idle?: Duration.Input,
) {
  return liveScreen(SubscriptionRef.changes(running), idle).pipe(
    Effect.provide(NodeWS.layerWebSocketConstructor),
  );
}

/** A viewer that keeps what it is shown, a frame's JPEG or `"blank"`, until its fiber is interrupted. */
function watch(screen: Stream.Stream<Screen>) {
  return Effect.gen(function* () {
    const seen: Array<string> = [];

    const fiber = yield* screen.pipe(
      Stream.runForEach((shown) =>
        Effect.sync(() =>
          seen.push(Screen.match(shown, { Blank: () => "blank", Frame: ({ jpeg }) => jpeg })),
        ),
      ),
      Effect.forkScoped,
    );

    return { seen, fiber };
  });
}

/** Runs `effect` and returns the messages it logged as warnings or worse. */
function warningsOf<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const warnings: Array<unknown> = [];

    const capture = Logger.make(({ logLevel, message }) => {
      if (LogLevel.isGreaterThanOrEqualTo(logLevel, "Warn")) warnings.push(message);
    });

    yield* effect.pipe(Effect.provide(Logger.layer([capture])));

    return warnings;
  });
}

const frame = (jpeg: string) => JSON.stringify(ScreenFrame.make({ jpeg }));

describe("liveScreen", () => {
  it.live("shows a blank screen and dials nothing while no computer runs", () =>
    Effect.gen(function* () {
      const computer = yield* serveScreen();
      const running = yield* SubscriptionRef.make(Option.none<ComputerAddress>());
      const viewer = yield* watch(yield* screenOf(running));

      yield* Effect.sleep("300 millis");

      expect(computer.connections).toEqual([]);
      expect(viewer.seen).toEqual(["blank"]);
    }).pipe(Effect.scoped),
  );

  it.live("sends the token and relays frames as they come", () =>
    Effect.gen(function* () {
      const computer = yield* serveScreen();
      const running = yield* SubscriptionRef.make(Option.some({ url: computer.url, token }));
      const viewer = yield* watch(yield* screenOf(running));

      yield* until("a connection", () => computer.connections.length === 1);
      computer.send(frame("AAAA"));
      yield* until("the first frame", () => viewer.seen.includes("AAAA"));
      computer.send(frame("BBBB"));
      yield* until("the second frame", () => viewer.seen.includes("BBBB"));

      expect(computer.connections[0]?.authorization).toBe("Bearer computer-token");
      expect(viewer.seen).toEqual(["blank", "AAAA", "BBBB"]);
    }).pipe(Effect.scoped),
  );

  it.live("gives a viewer who joins late the latest frame first", () =>
    Effect.gen(function* () {
      const computer = yield* serveScreen();
      const running = yield* SubscriptionRef.make(Option.some({ url: computer.url, token }));
      const screen = yield* screenOf(running);
      const first = yield* watch(screen);

      yield* until("a connection", () => computer.connections.length === 1);
      computer.send(frame("AAAA"));
      computer.send(frame("BBBB"));
      yield* until("two frames", () => first.seen.includes("BBBB"));

      const late = yield* watch(screen);
      yield* until("the late viewer's first frame", () => late.seen.length === 1);

      expect(late.seen).toEqual(["BBBB"]);
    }).pipe(Effect.scoped),
  );

  it.live("serves two viewers over one connection", () =>
    Effect.gen(function* () {
      const computer = yield* serveScreen();
      const running = yield* SubscriptionRef.make(Option.some({ url: computer.url, token }));
      const screen = yield* screenOf(running);
      const [one, two] = yield* Effect.all([watch(screen), watch(screen)]);

      yield* until("a connection", () => computer.connections.length === 1);
      computer.send(frame("AAAA"));
      yield* until(
        "both viewers' frame",
        () => one.seen.includes("AAAA") && two.seen.includes("AAAA"),
      );

      expect(computer.connections).toHaveLength(1);
      expect([one.seen, two.seen]).toEqual([
        ["blank", "AAAA"],
        ["blank", "AAAA"],
      ]);
    }).pipe(Effect.scoped),
  );

  it.live("dials the new computer with its new token when the computer is replaced", () =>
    Effect.gen(function* () {
      const before = yield* serveScreen();
      const after = yield* serveScreen();
      const running = yield* SubscriptionRef.make(Option.some({ url: before.url, token }));
      const viewer = yield* watch(yield* screenOf(running));

      yield* until("the first computer's connection", () => before.connections.length === 1);
      yield* SubscriptionRef.set(
        running,
        Option.some({ url: after.url, token: Redacted.make("fresh-token") }),
      );
      yield* until("the new computer's connection", () => after.connections.length === 1);
      yield* until("the old connection to close", () => before.connections[0]?.open === false);
      after.send(frame("CCCC"));
      yield* until("the new computer's frame", () => viewer.seen.includes("CCCC"));

      expect(after.connections[0]?.authorization).toBe("Bearer fresh-token");
      expect(viewer.seen).toEqual(["blank", "blank", "CCCC"]);
    }).pipe(Effect.scoped),
  );

  it.live("keeps its connection when the same computer is published again", () =>
    Effect.gen(function* () {
      const computer = yield* serveScreen();
      const running = yield* SubscriptionRef.make(Option.some({ url: computer.url, token }));
      const viewer = yield* watch(yield* screenOf(running));

      yield* until("a connection", () => computer.connections.length === 1);
      yield* SubscriptionRef.set(
        running,
        Option.some({ url: computer.url, token: Redacted.make("computer-token") }),
      );
      yield* Effect.sleep("300 millis");

      expect(computer.connections).toEqual([
        { authorization: "Bearer computer-token", open: true },
      ]);
      expect(viewer.seen).toEqual(["blank"]);
    }).pipe(Effect.scoped),
  );

  it.live("hangs up once the computer stops, and does not dial it again", () =>
    Effect.gen(function* () {
      const computer = yield* serveScreen();
      const running = yield* SubscriptionRef.make(Option.some({ url: computer.url, token }));
      yield* watch(yield* screenOf(running));

      yield* until("a connection", () => computer.connections.length === 1);
      yield* SubscriptionRef.set(running, Option.none());
      yield* until("the connection to close", () => computer.connections[0]?.open === false);
      yield* Effect.sleep("600 millis");

      expect(computer.connections).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.live(
    "shows a viewer who joins after the computer stopped a blank screen, not its last frame",
    () =>
      Effect.gen(function* () {
        const computer = yield* serveScreen();
        const running = yield* SubscriptionRef.make(Option.some({ url: computer.url, token }));
        const screen = yield* screenOf(running);
        const first = yield* watch(screen);

        yield* until("a connection", () => computer.connections.length === 1);
        computer.send(frame("AAAA"));
        yield* until("the frame", () => first.seen.includes("AAAA"));
        yield* SubscriptionRef.set(running, Option.none());
        yield* until("the connection to close", () => computer.connections[0]?.open === false);

        const late = yield* watch(screen);
        yield* until("the late viewer's screen", () => late.seen.length === 1);

        expect(late.seen).toEqual(["blank"]);
      }).pipe(Effect.scoped),
  );

  it.live(
    "shows a viewer who joins after the computer was replaced a blank screen until the new one paints",
    () =>
      Effect.gen(function* () {
        const before = yield* serveScreen();
        const after = yield* serveScreen();
        const running = yield* SubscriptionRef.make(Option.some({ url: before.url, token }));
        const screen = yield* screenOf(running);
        const first = yield* watch(screen);

        yield* until("the first computer's connection", () => before.connections.length === 1);
        before.send(frame("AAAA"));
        yield* until("its frame", () => first.seen.includes("AAAA"));
        yield* SubscriptionRef.set(
          running,
          Option.some({ url: after.url, token: Redacted.make("fresh-token") }),
        );
        yield* until("the new computer's connection", () => after.connections.length === 1);

        const late = yield* watch(screen);
        yield* until("the late viewer's screen", () => late.seen.length === 1);
        after.send(frame("CCCC"));
        yield* until("the new computer's frame", () => late.seen.length === 2);

        expect(late.seen).toEqual(["blank", "CCCC"]);
      }).pipe(Effect.scoped),
  );

  it.live(
    "closes the connection once nobody has watched for a while, not before, and quietly",
    () =>
      Effect.gen(function* () {
        const warnings = yield* warningsOf(
          Effect.gen(function* () {
            const computer = yield* serveScreen();
            const running = yield* SubscriptionRef.make(Option.some({ url: computer.url, token }));
            const viewer = yield* watch(yield* screenOf(running, "500 millis"));

            yield* until("a connection", () => computer.connections.length === 1);
            yield* Fiber.interrupt(viewer.fiber);
            yield* Effect.sleep("100 millis");

            expect(computer.connections[0]?.open).toBe(true);
            yield* until("the connection to close", () => computer.connections[0]?.open === false);
            yield* Effect.sleep("200 millis");
          }).pipe(Effect.scoped),
        );

        expect(warnings).toEqual([]);
      }),
  );

  it.live("warns and dials again after the computer drops the connection", () =>
    Effect.gen(function* () {
      const warnings = yield* warningsOf(
        Effect.gen(function* () {
          const computer = yield* serveScreen();
          const running = yield* SubscriptionRef.make(Option.some({ url: computer.url, token }));
          const viewer = yield* watch(yield* screenOf(running));

          yield* until("a connection", () => computer.connections.length === 1);
          computer.drop();
          yield* until("a second connection", () => computer.connections.length === 2);
          computer.send(frame("DDDD"));
          yield* until("a frame over the new connection", () => viewer.seen.includes("DDDD"));
        }).pipe(Effect.scoped),
      );

      expect(warnings).toEqual([["The screen connection dropped"]]);
    }),
  );

  it.live("shows a blank screen, not the last frame, while the computer does not answer", () =>
    Effect.gen(function* () {
      const computer = yield* serveScreen();
      const running = yield* SubscriptionRef.make(Option.some({ url: computer.url, token }));
      const screen = yield* screenOf(running);
      const first = yield* watch(screen);

      yield* until("a connection", () => computer.connections.length === 1);
      computer.send(frame("AAAA"));
      yield* until("the frame", () => first.seen.includes("AAAA"));
      computer.refuse();
      computer.drop();
      yield* until("a refused dial", () => computer.dials.length === 2);

      const late = yield* watch(screen);
      yield* until("the late viewer's screen", () => late.seen.length === 1);

      expect(first.seen).toEqual(["blank", "AAAA", "blank"]);
      expect(late.seen).toEqual(["blank"]);
    }).pipe(Effect.scoped),
  );

  it.live(
    "waits longer before each dial while the computer turns it away",
    () =>
      Effect.gen(function* () {
        const computer = yield* serveScreen();
        const running = yield* SubscriptionRef.make(Option.some({ url: computer.url, token }));
        const viewer = yield* watch(yield* screenOf(running));

        yield* until("a connection", () => computer.connections.length === 1);
        computer.send(frame("AAAA"));
        yield* until("the frame", () => viewer.seen.includes("AAAA"));
        computer.refuse();
        const droppedAt = performance.now();
        computer.drop();
        yield* until("three refused dials", () => computer.dials.length === 4);

        const times = [droppedAt, ...computer.dials.slice(1)];
        const gaps = Arr.zipWith(times.slice(1), times, (later, earlier) => later - earlier);
        const growth = Arr.zipWith(gaps.slice(1), gaps, (later, earlier) => later / earlier);

        expect(Math.min(...growth)).toBeGreaterThan(1.5);
      }).pipe(Effect.scoped),
    10_000,
  );

  it.live("dials again after a message that is not a frame", () =>
    Effect.gen(function* () {
      const computer = yield* serveScreen();
      const running = yield* SubscriptionRef.make(Option.some({ url: computer.url, token }));
      const viewer = yield* watch(yield* screenOf(running));

      yield* until("a connection", () => computer.connections.length === 1);
      computer.send('{"_tag":"Frame","jpeg":"<script>"}');
      yield* until("a second connection", () => computer.connections.length === 2);
      computer.send(frame("EEEE"));
      yield* until("a frame over the new connection", () => viewer.seen.includes("EEEE"));

      expect(viewer.seen).toEqual(["blank", "EEEE"]);
    }).pipe(Effect.scoped),
  );
});
