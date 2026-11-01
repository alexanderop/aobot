import {
  CommandEnd,
  type CommandRan,
  commandOutputLimit,
  commandTimeLimit,
  workspaceRoot,
} from "@aobot/domain";
import {
  Context,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  type PlatformError,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { startEgressProxyWithoutCredentials } from "../egress/public.ts";
import { commandEnvironment, type InheritedEnvironment } from "./environment.ts";
import { outputTail } from "./tail.ts";

/** The shell could not start the command, for example because bash would not start. Answered as `failed` (502). */
export class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  message: Schema.String,
}) {}

/** The computer's shell: `bash -c` in the workspace, one command at a time. */
export class Shell extends Context.Service<
  Shell,
  { readonly run: (command: string) => Effect.Effect<CommandRan, CommandFailed> }
>()("aobot/computer/shell/Shell") {}

/**
How long output may still arrive once bash has exited. A background job such as `sleep 600 &` keeps the
pipes open, and would otherwise hold the answer until the time limit. After a non-zero exit the spawner
has already killed the process group, so the pipes close at once.
*/
const outputGrace = Duration.millis(500);

/**
The end of a command that a signal ended. The spawner fails `exitCode` for it, and names the signal only
in that failure's message.
*/
function signalled(error: PlatformError.PlatformError): Option.Option<CommandEnd> {
  if (error.reason.method !== "exitCode") return Option.none();

  const signal = /signal: '(\w+)'/u.exec(String(error.reason.cause))?.[1] ?? "unknown";

  return Option.some(CommandEnd.cases.Signalled.make({ signal }));
}

/**
{@link Shell}, running each command with what it `inherited` and an egress proxy of its own, and nothing
else of this process's environment. A command runs in its own process group, and leaving the scope kills
that whole group, so a timeout, a Stop or the end of the output grace also ends `sleep 600 | cat` and
anything else the command started. `-c`, not `-lc`: a login shell would first run a `.bash_profile` the
Bot could have written in its workspace, so what ran would differ from the command in the audit row.
*/
export const shellLayer = (inherited: InheritedEnvironment) =>
  Layer.effect(
    Shell,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const environment = commandEnvironment(inherited, yield* startEgressProxyWithoutCredentials);
      const oneAtATime = yield* Semaphore.make(1);

      const run = Effect.fn("Shell.run")(function* (command: string) {
        const stdout = outputTail(commandOutputLimit);
        const stderr = outputTail(commandOutputLimit);

        const drain = <E>(stream: Stream.Stream<Uint8Array, E>, tail: typeof stdout) =>
          stream.pipe(
            Stream.decodeText,
            Stream.runForEach((piece) => Effect.sync(() => tail.add(piece))),
          );

        const { end, leftOutputOpen } = yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawner.spawn(
              ChildProcess.make("bash", ["-c", command], {
                cwd: workspaceRoot,
                env: environment,
                stdin: "ignore",
                killSignal: "SIGKILL",
              }),
            );

            const output = yield* Effect.forkScoped(
              Effect.all([drain(child.stdout, stdout), drain(child.stderr, stderr)], {
                concurrency: "unbounded",
                discard: true,
              }),
            );

            const ended = yield* child.exitCode.pipe(
              Effect.map((code): CommandEnd => CommandEnd.cases.Exited.make({ code })),
              Effect.catch((error) =>
                Option.match(signalled(error), {
                  onNone: () => Effect.fail(error),
                  onSome: Effect.succeed,
                }),
              ),
              Effect.timeoutOption(commandTimeLimit),
            );

            if (Option.isNone(ended)) {
              return { end: CommandEnd.cases.TimedOut.make({}), leftOutputOpen: false };
            }

            const drained = yield* Effect.timeoutOption(Fiber.join(output), outputGrace);

            return { end: ended.value, leftOutputOpen: Option.isNone(drained) };
          }),
        ).pipe(
          // Not the error's own message: it carries the command line, which a span would then record.
          Effect.mapError(
            ({ reason }) =>
              new CommandFailed({
                message: `The shell could not run the command (${reason._tag} in ${reason.method}).`,
              }),
          ),
        );

        return {
          action: "run",
          end,
          stdout: stdout.read(),
          stderr: stderr.read(),
          leftOutputOpen,
        } satisfies CommandRan;
      });

      return Shell.of({ run: (command) => oneAtATime.withPermits(1)(run(command)) });
    }),
  );
