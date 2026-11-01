import { type CommandRan, commandOutputLimit, commandTimeLimitMs } from "@aobot/domain";
import { Context, Duration, Effect, Layer, Option, Schema, Semaphore, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { startEgressProxyWithoutCredentials } from "../egress/public.ts";
import { commandEnvironment, type InheritedEnvironment, workspace } from "./environment.ts";
import { outputTail } from "./tail.ts";

/** The shell could not run the command at all, for example because bash would not start. Answered as `failed` (502). */
export class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  message: Schema.String,
}) {}

/** The computer's shell: `bash -c` in the workspace, one command at a time. */
export class Shell extends Context.Service<
  Shell,
  { readonly run: (command: string) => Effect.Effect<CommandRan, CommandFailed> }
>()("aobot/computer/shell/Shell") {}

/** What `timeout(1)` answers for a command it stopped, so a reader who knows shells reads it right. */
const timedOutExitCode = 124;

/**
{@link Shell}, running each command with what it `inherited` and an egress proxy of its own, and nothing
else of this process's environment. A command runs
in its own process group, and leaving the scope kills that whole group, so a timeout or a Stop also ends
`sleep 600 | cat` and anything else the command started. `-c`, not `-lc`: a login shell would first
run a `.bash_profile` the Bot could have written in its workspace, so what ran would differ from the
command in the audit row.
*/
export const shellLayer = (inherited: InheritedEnvironment) =>
  Layer.effect(
    Shell,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const environment = commandEnvironment(inherited, yield* startEgressProxyWithoutCredentials);
      // A command queued behind another is interrupted while it waits when its request is aborted, so a
      // Stop that lands before the spawn means it never runs.
      const oneAtATime = yield* Semaphore.make(1);

      const run = Effect.fn("Shell.run")(function* (command: string) {
        const stdout = outputTail(commandOutputLimit);
        const stderr = outputTail(commandOutputLimit);

        const drain = <E>(stream: Stream.Stream<Uint8Array, E>, tail: typeof stdout) =>
          stream.pipe(
            Stream.decodeText,
            Stream.runForEach((piece) => Effect.sync(() => tail.add(piece))),
          );

        const exited = yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawner.spawn(
              ChildProcess.make("bash", ["-c", command], {
                cwd: workspace,
                env: environment,
                stdin: "ignore",
                // A command can ignore SIGTERM; it cannot ignore this.
                killSignal: "SIGKILL",
              }),
            );

            const [exitCode] = yield* Effect.all(
              [child.exitCode, drain(child.stdout, stdout), drain(child.stderr, stderr)],
              { concurrency: "unbounded" },
            );

            return exitCode;
          }),
        ).pipe(
          Effect.timeoutOption(Duration.millis(commandTimeLimitMs)),
          // Not the error's own message: it carries the command line, which a span would then record.
          Effect.mapError(
            ({ reason }) =>
              new CommandFailed({
                message: `The shell could not run the command (${reason._tag} in ${reason.method}).`,
              }),
          ),
        );

        const out = stdout.read();
        const err = stderr.read();

        return {
          action: "run",
          exitCode: Option.getOrElse(exited, () => timedOutExitCode),
          stdout: out.text,
          stderr: err.text,
          truncated: out.truncated || err.truncated,
          timedOut: Option.isNone(exited),
        } satisfies CommandRan;
      });

      return Shell.of({ run: (command) => oneAtATime.withPermits(1)(run(command)) });
    }),
  );
