import { isDeepStrictEqual } from "node:util";
import {
  type Cause,
  Deferred,
  Effect,
  Layer,
  Option,
  Queue,
  type Schema,
  Sink,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  type Transcript,
  labelOf,
  lineSplitter,
  placeholders,
  readJson,
  substitute,
} from "./acp-transcript.ts";

/** A pause point: the replay stops before it writes the first message with this label. */
interface Gate {
  readonly reached: Deferred.Deferred<void>;
  readonly released: Deferred.Deferred<void>;
}

/** A recorded adapter, played back in-process, and the levers a test pulls on it. */
export interface Replay {
  /** A `ChildProcessSpawner` whose every spawn plays the transcript instead of starting a process. */
  readonly layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
  /** Wait until the replay holds at the gate `label`. */
  readonly reached: (label: string) => Effect.Effect<void>;
  /** Let the replay go on past the gate `label`. */
  readonly release: (label: string) => Effect.Effect<void>;
  /** The labels of the messages our client wrote, in order. */
  readonly sent: Effect.Effect<ReadonlyArray<string>>;
  /**
  Where our client parted from the recording: a message that differs from the recorded one, one it
  never sent, one it sent past the end, or a launch command that changed. Empty when they matched.
  */
  readonly problems: Effect.Effect<ReadonlyArray<string>>;
}

/**
Play `transcript` as if the adapter were running. Each spawn writes the recorded `emit` messages to
stdout, in order, and stops at each `expect` until our client writes that message, compared as JSON
with `<workspace>` filled in from the command's folder. Nothing is spawned and no time passes, so a test
runs on `it.effect`'s test clock.

`gateLabels` hold the replay before a message, by its label (`session/update`, `answer:2`), until the
test releases them: that is how a test catches the turn at an exact point, such as after the first
words and before the answer. If the client closes stdin while the replay is held, the replay ends like
an adapter that exits.
*/
export const makeReplay = Effect.fnUntraced(function* (
  transcript: Transcript,
  gateLabels: ReadonlyArray<string> = [],
) {
  const gates = new Map<string, Gate>();

  for (const label of gateLabels)
    gates.set(label, {
      reached: yield* Deferred.make<void>(),
      released: yield* Deferred.make<void>(),
    });

  const sent: Array<string> = [];
  const problems: Array<string> = [];
  const encoder = new TextEncoder();
  const recorded = [transcript.start.command, ...transcript.start.args].join(" ");

  const gate = (label: string): Effect.Effect<Gate> =>
    Option.match(Option.fromNullishOr(gates.get(label)), {
      onNone: () => Effect.die(`No replay gate named ${label}.`),
      onSome: (each) => Effect.succeed(each),
    });

  const spawn = (command: ChildProcess.Command) =>
    Effect.gen(function* () {
      const standard = ChildProcess.isStandardCommand(command)
        ? Option.some(command)
        : Option.none();

      const cwd = standard.pipe(
        Option.flatMap((each) => Option.fromNullishOr(each.options.cwd)),
        Option.getOrElse(() => ""),
      );

      for (const each of Option.toArray(standard)) {
        const launched = [each.command, ...each.args.map(String)].join(" ");

        if (launched !== recorded)
          problems.push(`launched \`${launched}\`, but the recording is of \`${recorded}\``);
      }

      const fill = (frame: Schema.Json) => substitute(frame, [[placeholders.workspace, cwd]]);
      const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      const stderr = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      const written = yield* Queue.unbounded<string, Cause.Done>();
      const stdinClosed = yield* Deferred.make<void>();
      const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const split = lineSplitter();
      const opened = new Set<string>();

      const receive = (line: string) => {
        sent.push(Option.match(readJson(line), { onNone: () => "unreadable", onSome: labelOf }));

        return Queue.offer(written, line);
      };

      const stdin = Sink.forEach((chunk: Uint8Array) =>
        Effect.forEach(
          split(chunk).filter((line) => line.trim() !== ""),
          receive,
          { discard: true },
        ),
      ).pipe(
        Sink.ensuring(
          Queue.end(written).pipe(Effect.andThen(Deferred.succeed(stdinClosed, undefined))),
        ),
      );

      // Like a real adapter, say why on stderr before exiting: our client quotes its last line.
      const problem = (text: string) =>
        Effect.sync(() => problems.push(text)).pipe(
          Effect.andThen(
            Queue.offer(stderr, encoder.encode(`replay: ${text.replaceAll("\n", " ")}\n`)),
          ),
        );

      const finish = Queue.end(stderr).pipe(
        Effect.andThen(Queue.end(stdout)),
        Effect.andThen(Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0))),
        Effect.asVoid,
      );

      // Whether the replay may go on: true once the gate opens, false if the client hangs up first.
      const pass = (label: string): Effect.Effect<boolean> => {
        const held = Option.fromNullishOr(opened.has(label) ? undefined : gates.get(label));

        return Option.match(held, {
          onNone: () => Effect.succeed(true),
          onSome: (each) => {
            opened.add(label);

            return Deferred.succeed(each.reached, undefined).pipe(
              Effect.andThen(
                Effect.raceFirst(
                  Deferred.await(each.released).pipe(Effect.as(true)),
                  Deferred.await(stdinClosed).pipe(Effect.as(false)),
                ),
              ),
            );
          },
        });
      };

      const play = Effect.gen(function* () {
        for (const entry of transcript.entries) {
          const frame = fill(entry.frame);
          const label = labelOf(frame);

          if (entry.type === "emit") {
            if (!(yield* pass(label))) return;
            yield* Queue.offer(stdout, encoder.encode(`${JSON.stringify(frame)}\n`));
            continue;
          }

          const line = yield* Effect.option(Queue.take(written));

          if (Option.isNone(line)) {
            yield* problem(`the client closed stdin before it sent ${label}`);

            return;
          }

          if (!Option.exists(readJson(line.value), (actual) => isDeepStrictEqual(actual, frame))) {
            yield* problem(`expected ${JSON.stringify(frame)}\nbut the client sent ${line.value}`);

            return;
          }
        }

        // The recording is over: like an adapter with nothing more to say, wait for stdin to close.
        while (true) {
          const extra = yield* Effect.option(Queue.take(written));

          if (Option.isNone(extra)) return;
          yield* problem(`the client sent ${extra.value} after the recording ended`);
        }
      });

      yield* play.pipe(Effect.ensuring(finish), Effect.forkScoped);

      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Deferred.await(exited),
        isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
        kill: () => finish,
        stdin,
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.fromQueue(stderr),
        all: Stream.fromQueue(stdout),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    });

  return {
    layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(spawn)),
    reached: (label) => Effect.flatMap(gate(label), (each) => Deferred.await(each.reached)),
    release: (label) =>
      Effect.flatMap(gate(label), (each) => Deferred.succeed(each.released, undefined)).pipe(
        Effect.asVoid,
      ),
    sent: Effect.sync(() => [...sent]),
    problems: Effect.sync(() => [...problems]),
  } satisfies Replay;
});
