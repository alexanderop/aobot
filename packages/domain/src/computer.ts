import { Schema } from "effect";

/** The longest snapshot the computer returns, in UTF-16 code units. A longer one is cut and marked `truncated`. */
export const snapshotLimit = 12_000;

/** How long a command may run before the computer stops it and everything it started. */
export const commandTimeLimitMs = 30_000;

/**
How much of each of a command's output streams comes back, in UTF-16 code units, kept from the end. Both
together stay well under what a tool result may hold.
*/
export const commandOutputLimit = 8_000;

/** An element of a page as the gateway resolved it from the Bot's latest snapshot. */
export const RefTarget = Schema.Struct({
  /** The element's ref in that snapshot, such as `e12`. */
  ref: Schema.String,
  role: Schema.String,
  /** Its accessible name, or `""` when the snapshot shows none. */
  name: Schema.String,
});

/** A decoded {@link RefTarget}. */
export type RefTarget = typeof RefTarget.Type;

/** Something a Bot asks its computer's browser to do. Each answers with a {@link PageRead}. */
export const PageAction = Schema.Union([
  Schema.Struct({ action: Schema.Literal("navigate"), url: Schema.String }),
  Schema.Struct({ action: Schema.Literal("snapshot") }),
  Schema.Struct({ action: Schema.Literal("click"), target: RefTarget }),
  Schema.Struct({ action: Schema.Literal("type"), target: RefTarget, text: Schema.String }),
]).pipe(Schema.toTaggedUnion("action"));

/** A decoded {@link PageAction}. */
export type PageAction = typeof PageAction.Type;

/** A command for the computer's shell: `bash -c` in `/workspace`. It answers with a {@link CommandRan}. */
export const RunCommand = Schema.Struct({ action: Schema.Literal("run"), command: Schema.String });

/** A decoded {@link RunCommand}. */
export type RunCommand = typeof RunCommand.Type;

/** One thing a Bot asks its computer to do. The body of `POST /act`, discriminated by `action`. */
export const ComputerAction = Schema.Union([PageAction, RunCommand]).pipe(
  Schema.toTaggedUnion("action"),
);

/** A decoded {@link ComputerAction}. */
export type ComputerAction = typeof ComputerAction.Type;

/**
The page as it is after a {@link PageAction}, read afresh, so the Bot's refs always come from the page it
is looking at.
*/
export const PageRead = Schema.Struct({
  action: Schema.Literals(["navigate", "snapshot", "click", "type"]),
  url: Schema.String,
  title: Schema.String,
  snapshot: Schema.String,
  truncated: Schema.Boolean,
});

/** A decoded {@link PageRead}. */
export type PageRead = typeof PageRead.Type;

/**
How a {@link RunCommand} ended. `stdout` and `stderr` are each the last {@link commandOutputLimit} code
units, and `truncated` says anything before them was dropped. A command still running at
{@link commandTimeLimitMs} is stopped with all it started, and answers `timedOut` with exit code 124, as
`timeout(1)` does.
*/
export const CommandRan = Schema.Struct({
  action: Schema.Literal("run"),
  exitCode: Schema.Int,
  stdout: Schema.String,
  stderr: Schema.String,
  truncated: Schema.Boolean,
  timedOut: Schema.Boolean,
});

/** A decoded {@link CommandRan}. */
export type CommandRan = typeof CommandRan.Type;

/** What the computer answers, with status 200, to a {@link ComputerAction} it carried out. */
export const ComputerActResult = Schema.Union([PageRead, CommandRan]);

/** A decoded {@link ComputerActResult}. */
export type ComputerActResult = typeof ComputerActResult.Type;

/**
Why the computer did not carry out an action. `refused` (status 403) means it never tried, for example a
private address; `failed` (status 502) means it tried and the browser or the shell failed.
*/
export const ComputerActError = Schema.Struct({
  reason: Schema.Literals(["refused", "failed"]),
  message: Schema.String,
});

/** A decoded {@link ComputerActError}. */
export type ComputerActError = typeof ComputerActError.Type;
