import { Duration, Schema, SchemaTransformation } from "effect";

/** The longest snapshot the computer returns, in UTF-16 code units. A longer one is cut and marked `truncated`. */
export const snapshotLimit = 12_000;

/** How long a command may run before the computer stops it. */
export const commandTimeLimit = Duration.seconds(30);

/**
How much of each of a command's output streams comes back, in UTF-16 code units, kept from the end. Both
together stay well under what a tool result may hold.
*/
export const commandOutputLimit = 8_000;

/**
How much of a file `read_file` hands the model, in bytes from its start. Decoded, it stays well under what
a tool result may hold.
*/
export const fileReadLimit = 16_000;

/** The most bytes one `write_file` may save, so a loop cannot fill the workspace. */
export const fileWriteLimit = 1_000_000;

/** The most entries one `list_files` answers, so a Bot cannot paste a whole disk into its context. */
export const fileListLimit = 500;

/** The most bytes a person may upload into the workspace or download from it in one file: 100 MiB. */
export const fileTransferLimit = 100 * 1024 * 1024;

/** The Bot's own folder: where its commands run, their HOME, and where its files live, named relative to it. */
export const workspaceRoot = "/workspace";

/**
Whether `path` reaches outside the workspace as the computer, which runs Linux, reads it: an absolute path,
or one that goes up a folder with `..`. `\` is part of a name there, not a separator. Only the computer can
see where a symlink inside the workspace leads.
*/
export function escapesWorkspace(path: string): boolean {
  return path.startsWith("/") || path.split("/").includes("..");
}

/**
A path inside the workspace as a Bot or a person names it, relative to it. `""` decodes as `.`, the
workspace itself, so the gateway and the computer judge one spelling. Never trimmed: `a.txt ` is a file of
its own, and the gateway and the computer must see the same name.
*/
export const WorkspacePath = Schema.String.pipe(
  Schema.decode(
    SchemaTransformation.transform({
      decode: (path) => (path === "" ? "." : path),
      encode: (path) => path,
    }),
  ),
);

/** The last part of `path`, the name a file is saved under, split as {@link escapesWorkspace} splits it. */
export function fileName(path: string): string {
  return (
    path
      .split("/")
      .filter((part) => part !== "")
      .at(-1) ?? ""
  );
}

/** The query of a person's `GET` or `PUT /files`, on the server and on the computer: which file. */
export const FileQuery = Schema.Struct({ path: WorkspacePath });

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

/**
Something a Bot asks of the files in its workspace, by its {@link WorkspacePath}. `read_file` answers with
a {@link FileRead}, `write_file` with a {@link FileWritten}, and `list_files`, where `.` names the
workspace itself, with a {@link FileList}.
*/
export const FileAction = Schema.Union([
  Schema.Struct({ action: Schema.Literal("read_file"), path: WorkspacePath }),
  Schema.Struct({
    action: Schema.Literal("write_file"),
    path: WorkspacePath,
    contents: Schema.String,
  }),
  Schema.Struct({ action: Schema.Literal("list_files"), path: WorkspacePath }),
]).pipe(Schema.toTaggedUnion("action"));

/** A decoded {@link FileAction}. */
export type FileAction = typeof FileAction.Type;

/** One thing a Bot asks its computer to do. The body of `POST /act`, discriminated by `action`. */
export const ComputerAction = Schema.Union([PageAction, RunCommand, FileAction]).pipe(
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

/**
The start of a text file: its first {@link fileReadLimit} bytes as UTF-8, `truncated` when there were more,
and the size of the whole file.
*/
export const FileRead = Schema.Struct({
  action: Schema.Literal("read_file"),
  path: Schema.String,
  text: Schema.String,
  truncated: Schema.Boolean,
  bytes: Schema.Int,
});

/** A decoded {@link FileRead}. */
export type FileRead = typeof FileRead.Type;

/** A file a Bot's `write_file` saved in the workspace, and how many bytes it holds. */
export const FileWritten = Schema.Struct({
  action: Schema.Literal("write_file"),
  path: Schema.String,
  bytes: Schema.Int,
});

/** A decoded {@link FileWritten}. */
export type FileWritten = typeof FileWritten.Type;

/** A file a person uploaded, saved in the workspace at `path`, and how many bytes it holds. */
export const FileSaved = Schema.Struct({ path: Schema.String, bytes: Schema.Int });

/** A decoded {@link FileSaved}. */
export type FileSaved = typeof FileSaved.Type;

/**
One file or folder in the workspace, by its path relative to it. Only a file has a size. `unreadable` is a
folder that could not be opened or a file that could not be sized, so the rest of the listing still comes
back.
*/
export const FileEntry = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("file"), path: Schema.String, bytes: Schema.Int }),
  Schema.Struct({ kind: Schema.Literal("folder"), path: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("unreadable"), path: Schema.String }),
]).pipe(Schema.toTaggedUnion("kind"));

/** A decoded {@link FileEntry}. */
export type FileEntry = typeof FileEntry.Type;

/**
The files and folders under a folder of the workspace, every level down, at most {@link fileListLimit},
`truncated` when there were more.
*/
export const FileList = Schema.Struct({
  action: Schema.Literal("list_files"),
  path: Schema.String,
  entries: Schema.Array(FileEntry),
  truncated: Schema.Boolean,
});

/** A decoded {@link FileList}. */
export type FileList = typeof FileList.Type;

/** What the computer answers to a {@link FileAction}: the shape its own action names. */
export const FileAnswer = Schema.Union([FileRead, FileWritten, FileList]).pipe(
  Schema.toTaggedUnion("action"),
);

/** A decoded {@link FileAnswer}. */
export type FileAnswer = typeof FileAnswer.Type;

/** What the computer answers, with status 200, to a {@link ComputerAction} it carried out. */
export const ComputerActResult = Schema.Union([PageRead, CommandRan, FileAnswer]);

/** A decoded {@link ComputerActResult}. */
export type ComputerActResult = typeof ComputerActResult.Type;

/**
Why the computer did not carry out an action. `refused` (status 403, or 413 for an upload past
{@link fileTransferLimit}) means it never tried, for example a private address or a path outside the
workspace; `failed` (status 502) means it tried and the browser, the shell or the file system failed.
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
