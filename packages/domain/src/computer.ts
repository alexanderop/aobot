import { Duration, Schema } from "effect";

/** The longest snapshot the computer returns, in UTF-16 code units. A longer one is cut and marked `truncated`. */
export const snapshotLimit = 12_000;

/** How long a command may run before the computer stops it. */
export const commandTimeLimit = Duration.seconds(30);

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
What a command printed to one stream: its last {@link commandOutputLimit} code units, and whether
anything before them was dropped.
*/
export const CommandOutput = Schema.Struct({ text: Schema.String, truncated: Schema.Boolean });

/** A decoded {@link CommandOutput}. */
export type CommandOutput = typeof CommandOutput.Type;

/**
How a command ended. `Exited` with the code bash exited with. `Signalled` when bash was ended by a signal
the computer did not send, such as `kill -TERM $$`, a crash or the out-of-memory killer. `TimedOut` when
it was still running at {@link commandTimeLimit}, so the computer stopped it.
*/
export const CommandEnd = Schema.TaggedUnion({
  Exited: { code: Schema.Int },
  Signalled: { signal: Schema.String },
  TimedOut: {},
});

/** A decoded {@link CommandEnd}. */
export type CommandEnd = typeof CommandEnd.Type;

/** How a {@link RunCommand} ended, and what it printed until then. */
export const CommandRan = Schema.Struct({
  action: Schema.Literal("run"),
  end: CommandEnd,
  stdout: CommandOutput,
  stderr: CommandOutput,
  /**
  Whether something the command left running, such as `sleep 600 &`, still held its output open half a
  second after bash ended, so the computer stopped it there. What it would have printed later is missing.
  Anything left running is stopped when bash ends; this says only that it was cut off mid-output.
  */
  leftOutputOpen: Schema.Boolean,
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

/**
What a person watching a computer is shown. `Frame` is a JPEG as Chromium's screencast painted it, in
base64, so the page's `data:image/jpeg;base64,…` src can only ever be an image. A frame shows whatever
the Bot typed, so it never goes into a log, a span or an audit row (decision 8).
*/
export const Screen = Schema.TaggedUnion({
  Blank: {},
  Frame: { jpeg: Schema.String.check(Schema.isBase64()) },
});

/** A decoded {@link Screen}. */
export type Screen = typeof Screen.Type;

/** One picture of the screen: all the computer's `/stream` sends, and what the server passes on as it is. */
export const ScreenFrame = Screen.cases.Frame;

/** A decoded {@link ScreenFrame}. */
export type ScreenFrame = typeof ScreenFrame.Type;
