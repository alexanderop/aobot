import { realpath } from "node:fs/promises";
import {
  escapesWorkspace,
  FileAction,
  type FileAnswer,
  type FileEntry,
  type FileList,
  fileListLimit,
  type FileRead,
  fileReadLimit,
  type FileSaved,
  fileTransferLimit,
  type FileWritten,
  fileWriteLimit,
  workspaceRoot,
} from "@aobot/domain";
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  PlatformError,
  Predicate,
  Schema,
  Sink,
  Stream,
} from "effect";

/** The workspace would not touch the file, so it never tried. Answered as `refused` (403). */
export class FileRefused extends Schema.TaggedError<FileRefused>()("FileRefused", {
  message: Schema.String,
}) {}

/** The workspace tried and the file system failed, or the file is not there. Answered as `failed` (502). */
export class FileFailed extends Schema.TaggedError<FileFailed>()("FileFailed", {
  message: Schema.String,
}) {}

/** An upload ran past {@link fileTransferLimit}, so nothing of it was kept. Answered as `refused` (413). */
export class FileTooLarge extends Schema.TaggedError<FileTooLarge>()("FileTooLarge", {
  message: Schema.String,
}) {}

/** A file ready to send as it is: its size, and its bytes, read from disk as they are sent. */
interface FileDownload {
  readonly bytes: number;
  readonly body: Stream.Stream<Uint8Array, FileFailed>;
}

/** The Bot's files in its workspace, confined to it. */
export class Workspace extends Context.Service<
  Workspace,
  {
    /** A Bot's `read_file`, `write_file` or `list_files`. */
    readonly act: (action: FileAction) => Effect.Effect<FileAnswer, FileRefused | FileFailed>;
    /** The exact bytes of the file at `path`, for a person's download. */
    readonly download: (path: string) => Effect.Effect<FileDownload, FileRefused | FileFailed>;
    /** Saves `body` at `path`, replacing what was there only once all of it arrived. */
    readonly upload: (
      path: string,
      body: Stream.Stream<Uint8Array, FileFailed>,
    ) => Effect.Effect<FileSaved, FileRefused | FileFailed | FileTooLarge>;
  }
>()("aobot/computer/workspace/Workspace") {}

/** How many links a chain may pass through before it counts as a loop. Linux gives up at 40. */
const linkHops = 32;

function outside(shown: string): FileRefused {
  return new FileRefused({
    message: `${shown} is outside your workspace, so it cannot be reached. Name a file by its path inside ${workspaceRoot}, such as notes.txt.`,
  });
}

function unreachable(shown: string) {
  return (error: PlatformError.PlatformError) =>
    Predicate.isTagged(error.reason, "NotFound")
      ? new FileFailed({ message: `There is nothing at ${shown}.` })
      : new FileFailed({ message: `${shown} could not be reached (${error.reason._tag}).` });
}

const systemErrors = new Map<unknown, PlatformError.SystemErrorTag>([
  ["ENOENT", "NotFound"],
  ["EACCES", "PermissionDenied"],
  ["EPERM", "PermissionDenied"],
  ["ENOTDIR", "BadResource"],
]);

/**
`target` with every link in it followed as the kernel follows it. `FileSystem.realPath` is Node's own
walk, which reads `..` after a link as text: with `sub` a link out of the workspace, it puts `sub/..` back
inside it, where the kernel goes up from where `sub` leads.
*/
function realPath(target: string): Effect.Effect<string, PlatformError.PlatformError> {
  return Effect.tryPromise({
    try: () => realpath(target),
    catch: (cause) =>
      PlatformError.systemError({
        _tag: (Predicate.hasProperty(cause, "code") && systemErrors.get(cause.code)) || "Unknown",
        module: "FileSystem",
        method: "realPath",
        pathOrDescriptor: target,
        cause,
      }),
  });
}

/** `body`, failing with `tooLarge` once more than `limit` bytes went through. */
function capped(
  body: Stream.Stream<Uint8Array, FileFailed>,
  limit: number,
  tooLarge: () => FileTooLarge,
): Stream.Stream<Uint8Array, FileFailed | FileTooLarge> {
  return Stream.suspend(() => {
    const seen = { bytes: 0 };

    return Stream.mapEffect(body, (chunk) => {
      seen.bytes += chunk.length;

      return seen.bytes > limit ? Effect.fail(tooLarge()) : Effect.succeed(chunk);
    });
  });
}

/**
{@link Workspace} over the folder `root`, confined to it in two layers, as OpenBot's `workspace.ts` is:

1. A path is refused as written when it is absolute or goes up with `..`.
2. Resolved on disk, with every link followed, it must still be inside `root`. A link a command placed in
   the workspace passes the first layer and points anywhere. A write resolves the folder it lands in, and
   also walks a link already at the name, because a write lands where that link points.

Containment compares a relative path, never a prefix, so `/workspace-evil` is not inside `/workspace`. A
link that points back inside keeps working. A factory over `root`, so the confinement is tested against a
folder of its own rather than taken on trust.
*/
export const workspaceLayer = (root: string) =>
  Layer.effect(
    Workspace,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const realRoot = realPath(root).pipe(
        Effect.mapError(() => new FileFailed({ message: "The workspace is missing." })),
      );

      const inside = (base: string, candidate: string, shown: string) => {
        const relative = path.relative(base, candidate);

        const leaves =
          relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);

        return leaves ? Effect.fail(outside(shown)) : Effect.void;
      };

      /** Refuses a path as the Bot wrote it, before anything on disk is looked at. */
      const named = (requested: string) =>
        escapesWorkspace(requested) ? Effect.fail(outside(requested)) : Effect.void;

      /** The real path of what is at `requested`, which must exist. */
      const existing = Effect.fnUntraced(function* (requested: string) {
        yield* named(requested);

        const base = yield* realRoot;

        const real = yield* realPath(path.resolve(base, requested)).pipe(
          Effect.mapError(unreachable(requested)),
        );

        yield* inside(base, real, requested);

        return real;
      });

      /** The real path of the closest folder at or above `folder` that exists. */
      const nearestExisting = (folder: string): Effect.Effect<string, FileFailed> =>
        realPath(folder).pipe(
          Effect.catchTag("PlatformError", (error) => {
            const parent = path.dirname(folder);

            return Predicate.isTagged(error.reason, "NotFound") && parent !== folder
              ? nearestExisting(parent)
              : Effect.fail(unreachable(folder)(error));
          }),
        );

      /**
      Where a write to `target` lands: `target` itself unless a link is already there, else where the chain
      of links ends. Walked with `lstat` and `readlink`, not `realpath`, which fails on a dangling link that
      a write would still follow. Each hop's folder is resolved on disk, never as text, because the kernel
      reads a link from the folder it is really in.
      */
      const landing = (
        target: string,
        shown: string,
        hops = 0,
      ): Effect.Effect<string, FileRefused | FileFailed> =>
        Effect.gen(function* () {
          const entry = yield* Effect.option(fs.lstat(target));

          if (Option.isNone(entry) || entry.value.type !== "SymbolicLink") return target;

          if (hops === linkHops) {
            return yield* new FileRefused({
              message: `${shown} is a chain of links that does not end, so where it leads cannot be known.`,
            });
          }

          const link = yield* fs.readLink(target).pipe(Effect.mapError(unreachable(shown)));
          const next = path.isAbsolute(link) ? link : `${path.dirname(target)}${path.sep}${link}`;

          const folder = yield* realPath(path.dirname(next)).pipe(
            Effect.mapError(
              () =>
                new FileRefused({
                  message: `${shown} is a link to somewhere that does not exist, so where a write lands cannot be known.`,
                }),
            ),
          );

          return yield* landing(path.join(folder, path.basename(next)), shown, hops + 1);
        });

      /** The path a write to `requested` lands at, inside the workspace. The file need not exist yet. */
      const destination = Effect.fnUntraced(function* (requested: string) {
        yield* named(requested);

        const base = yield* realRoot;
        const target = path.resolve(base, requested);

        yield* inside(base, yield* nearestExisting(path.dirname(target)), requested);

        const end = yield* landing(target, requested);

        yield* inside(base, end, requested);

        return end;
      });

      /**
      Writes `body` to a file of its own beside `real`, then renames it onto `real`, so a write that fails
      or is refused partway leaves what was there before and nothing else. The temporary name is short, so
      a name as long as a name may be still fits beside it.
      */
      const save = <E>(real: string, shown: string, body: Stream.Stream<Uint8Array, E>) => {
        const folder = path.dirname(real);
        const partial = path.join(folder, `.aobot-${crypto.randomUUID()}.part`);
        const onDisk = Effect.mapError(unreachable(shown));

        return Effect.gen(function* () {
          yield* onDisk(fs.makeDirectory(folder, { recursive: true }));
          yield* Stream.run(
            body,
            fs.sink(partial, { flag: "wx" }).pipe(Sink.mapError(unreachable(shown))),
          );

          const { size } = yield* onDisk(fs.stat(partial));

          yield* onDisk(fs.rename(partial, real));

          return Number(size);
        }).pipe(Effect.ensuring(Effect.ignore(fs.remove(partial, { force: true }))));
      };

      /** The file's info, refused unless it is a regular file. A FIFO would hold a read forever. */
      const regularFile = (real: string, shown: string) =>
        fs.stat(real).pipe(
          Effect.mapError(unreachable(shown)),
          Effect.filterOrFail(
            (info) => info.type === "File",
            (info) =>
              new FileFailed({
                message:
                  info.type === "Directory"
                    ? `${shown} is a folder, not a file. List it with list_files.`
                    : `${shown} is not a file.`,
              }),
          ),
        );

      const read = Effect.fn("Workspace.read")(function* (requested: string) {
        const real = yield* existing(requested);
        const bytes = Number((yield* regularFile(real, requested)).size);

        const start = yield* fs
          .stream(real, { bytesToRead: fileReadLimit })
          .pipe(Stream.runCollect, Effect.mapError(unreachable(requested)));

        const truncated = bytes > fileReadLimit;

        return {
          action: "read_file",
          path: requested,
          // A binary file reads as replacement characters. `stream` holds back a character the cut split.
          text: new TextDecoder().decode(Buffer.concat(start), { stream: truncated }),
          truncated,
          bytes,
        } satisfies FileRead;
      });

      const write = Effect.fn("Workspace.write")(function* (requested: string, contents: string) {
        const encoded = new TextEncoder().encode(contents);

        if (encoded.length > fileWriteLimit) {
          return yield* new FileRefused({
            message: `That is ${encoded.length} bytes, and one write may hold at most ${fileWriteLimit}.`,
          });
        }

        const real = yield* destination(requested);
        const bytes = yield* save(real, requested, Stream.make(encoded));

        return { action: "write_file", path: requested, bytes } satisfies FileWritten;
      });

      /** The entries of `folder`, in name order. */
      const entriesOf = (folder: string) =>
        Effect.map(fs.readDirectoryEntries(folder), (entries) =>
          [...entries].sort((a, b) => a.name.localeCompare(b.name)),
        );

      /**
      Every file and folder below `folder`, whose `entries` are already read, depth first in name order, one
      more than the limit at most. What cannot be read is listed as `unreadable` and the walk goes on.
      */
      const walk = (
        base: string,
        folder: string,
        entries: ReadonlyArray<{ readonly name: string; readonly type: string }>,
        found: Array<FileEntry>,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          for (const { name, type } of entries) {
            if (found.length > fileListLimit) return;

            const full = path.join(folder, name);
            const shown = path.relative(base, full);
            const unreadable = { kind: "unreadable", path: shown } as const;

            // A link is not followed: one to `/` would list the whole computer.
            if (type === "Directory") {
              const inner = yield* Effect.option(entriesOf(full));

              if (Option.isNone(inner)) {
                found.push(unreadable);
              } else {
                found.push({ kind: "folder", path: shown });
                yield* walk(base, full, inner.value, found);
              }
            } else if (type === "File") {
              const info = yield* Effect.option(fs.stat(full));

              found.push(
                Option.match(info, {
                  onNone: () => unreadable,
                  onSome: ({ size }) =>
                    ({ kind: "file", path: shown, bytes: Number(size) }) as const,
                }),
              );
            }
          }
        });

      const list = Effect.fn("Workspace.list")(function* (requested: string) {
        const base = yield* realRoot;
        const real = yield* existing(requested);
        const info = yield* fs.stat(real).pipe(Effect.mapError(unreachable(requested)));

        if (info.type !== "Directory") {
          return yield* new FileFailed({ message: `${requested} is a file, not a folder.` });
        }

        const found: Array<FileEntry> = [];

        yield* walk(
          base,
          real,
          yield* entriesOf(real).pipe(Effect.mapError(unreachable(requested))),
          found,
        );

        return {
          action: "list_files",
          path: requested,
          entries: found.slice(0, fileListLimit),
          truncated: found.length > fileListLimit,
        } satisfies FileList;
      });

      const download = Effect.fn("Workspace.download")(function* (requested: string) {
        const real = yield* existing(requested);
        const bytes = Number((yield* regularFile(real, requested)).size);

        if (bytes > fileTransferLimit) {
          return yield* new FileRefused({
            message: `${requested} is ${bytes} bytes, and a download may hold at most ${fileTransferLimit}.`,
          });
        }

        return {
          bytes,
          body: fs
            .stream(real, { bytesToRead: bytes })
            .pipe(Stream.mapError(unreachable(requested))),
        } satisfies FileDownload;
      });

      const upload = Effect.fn("Workspace.upload")(function* (
        requested: string,
        body: Stream.Stream<Uint8Array, FileFailed>,
      ) {
        const real = yield* destination(requested);

        const bytes = yield* save(
          real,
          requested,
          capped(
            body,
            fileTransferLimit,
            () =>
              new FileTooLarge({
                message: `An upload may hold at most ${fileTransferLimit} bytes, so ${requested} was not saved.`,
              }),
          ),
        );

        return { path: requested, bytes } satisfies FileSaved;
      });

      return Workspace.of({
        act: FileAction.match({
          read_file: ({ path: requested }) => read(requested),
          write_file: ({ path: requested, contents }) => write(requested, contents),
          list_files: ({ path: requested }) => list(requested),
        }),
        download,
        upload,
      });
    }),
  );
