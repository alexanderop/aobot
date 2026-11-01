import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileAnswer, fileListLimit, fileReadLimit, fileWriteLimit } from "@aobot/domain";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { FileFailed, Workspace, workspaceLayer } from "./workspace.ts";

/**
A workspace in a folder of its own, beside a folder outside it holding `secret.txt` and a sibling whose name
starts with the workspace's, as `/workspace-evil` does with `/workspace`. Removed with the scope.
*/
const folders = Effect.acquireRelease(
  Effect.promise(async () => {
    const top = await mkdtemp(join(tmpdir(), "aobot-workspace-"));
    const root = join(top, "workspace");
    const outside = join(top, "outside");

    await Promise.all([mkdir(root), mkdir(outside), mkdir(`${root}-evil`)]);
    await Promise.all([
      writeFile(join(outside, "secret.txt"), "outside"),
      writeFile(join(`${root}-evil`, "secret.txt"), "evil"),
    ]);

    return { top, root, outside };
  }),
  ({ top }) => Effect.promise(() => rm(top, { recursive: true, force: true })),
);

/** `test` with the workspace over a fresh folder, and that folder's paths. */
function inWorkspace<A, E>(
  test: (folder: {
    readonly top: string;
    readonly root: string;
    readonly outside: string;
  }) => Effect.Effect<A, E, Workspace>,
) {
  return Effect.scoped(
    Effect.flatMap(folders, (folder) =>
      test(folder).pipe(
        Effect.provide(workspaceLayer(folder.root).pipe(Layer.provide(NodeServices.layer))),
      ),
    ),
  );
}

const act = (action: Parameters<Workspace["Service"]["act"]>[0]) =>
  Workspace.use((workspace) => workspace.act(action));

/** `act`, holding its answer to what its action promises. */
const answer =
  <A extends FileAnswer>(promised: (answer: FileAnswer) => answer is A) =>
  <E, R>(acted: Effect.Effect<FileAnswer, E, R>) =>
    Effect.flatMap(acted, (given) =>
      promised(given) ? Effect.succeed(given) : Effect.die("the workspace answered another action"),
    );

const read = (path: string) =>
  act({ action: "read_file", path }).pipe(answer(FileAnswer.guards.read_file));

const write = (path: string, contents: string) =>
  act({ action: "write_file", path, contents }).pipe(answer(FileAnswer.guards.write_file));

const list = (path: string) =>
  act({ action: "list_files", path }).pipe(answer(FileAnswer.guards.list_files));

/** Why `effect` failed, as the tag the HTTP routes answer by. */
const refusal = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.flip(effect), (error) => error._tag);

describe("a Bot's path", () => {
  it.effect("reads and writes a file named by its path inside the workspace", () =>
    inWorkspace(({ root }) =>
      Effect.gen(function* () {
        expect(yield* write("notes.txt", "hello")).toEqual({
          action: "write_file",
          path: "notes.txt",
          bytes: 5,
        });
        expect(yield* read("notes.txt")).toEqual({
          action: "read_file",
          path: "notes.txt",
          text: "hello",
          truncated: false,
          bytes: 5,
        });
        expect(yield* Effect.promise(() => readFile(join(root, "notes.txt"), "utf8"))).toBe(
          "hello",
        );
      }),
    ),
  );

  it.effect.each([
    ["an absolute path", "/etc/passwd"],
    ["the workspace's own absolute path", "/workspace/notes.txt"],
    ["a path up out of it", "../outside/secret.txt"],
    ["a path that goes up through a folder", "reports/../../outside/secret.txt"],
  ])("refuses %s before looking at the disk", ([, path]) =>
    inWorkspace(() =>
      Effect.gen(function* () {
        expect(yield* refusal(read(path))).toBe("FileRefused");
        expect(yield* refusal(write(path, "x"))).toBe("FileRefused");
        expect(yield* refusal(list(path))).toBe("FileRefused");
      }),
    ),
  );

  it.effect(
    "refuses to read or write through a link inside the workspace that points at /etc",
    () =>
      inWorkspace(({ root }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              symlink("/etc", join(root, "etc")),
              symlink("/etc/passwd", join(root, "passwd")),
            ]),
          );

          expect(yield* refusal(read("etc/passwd"))).toBe("FileRefused");
          expect(yield* refusal(read("passwd"))).toBe("FileRefused");
          expect(yield* refusal(write("etc/aobot.txt", "x"))).toBe("FileRefused");
          expect(yield* refusal(write("passwd", "x"))).toBe("FileRefused");
          expect(yield* refusal(list("etc"))).toBe("FileRefused");
        }),
      ),
  );

  it.effect(
    "refuses a write through a link at the name itself, leaving what it points at alone",
    () =>
      inWorkspace(({ root, outside }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            symlink(join(outside, "secret.txt"), join(root, "notes.txt")),
          );

          expect(yield* refusal(write("notes.txt", "overwritten"))).toBe("FileRefused");
          expect(yield* Effect.promise(() => readFile(join(outside, "secret.txt"), "utf8"))).toBe(
            "outside",
          );
        }),
      ),
  );

  it.effect(
    "refuses a write through a dangling link that points outside, creating nothing there",
    () =>
      inWorkspace(({ root, outside }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => symlink(join(outside, "planted.txt"), join(root, "new.txt")));

          expect(yield* refusal(write("new.txt", "x"))).toBe("FileRefused");
          expect(yield* refusal(read("new.txt"))).toBe("FileFailed");
          expect(yield* Effect.promise(() => readdir(outside))).toEqual(["secret.txt"]);
        }),
      ),
  );

  it.effect("refuses a link into a sibling whose name starts with the workspace's", () =>
    inWorkspace(({ root }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          symlink(join(`${root}-evil`, "secret.txt"), join(root, "evil.txt")),
        );

        expect(yield* refusal(read("evil.txt"))).toBe("FileRefused");
        expect(yield* refusal(write("evil.txt", "x"))).toBe("FileRefused");
      }),
    ),
  );

  it.effect("refuses a chain of links that never ends", () =>
    inWorkspace(({ root }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          Promise.all([symlink("b", join(root, "a")), symlink("a", join(root, "b"))]),
        );

        expect(yield* refusal(write("a", "x"))).toBe("FileRefused");
      }),
    ),
  );

  it.effect("writes a name as it is written, a trailing space and all", () =>
    inWorkspace(({ root }) =>
      Effect.gen(function* () {
        yield* write("a.txt", "plain");
        yield* write("a.txt ", "spaced");

        expect(yield* Effect.promise(() => readFile(join(root, "a.txt"), "utf8"))).toBe("plain");
        expect((yield* read("a.txt ")).text).toBe("spaced");
        expect(yield* refusal(read(" a.txt"))).toBe("FileFailed");
      }),
    ),
  );

  it.effect("writes through a link where the link leads, from the folder it is really in", () =>
    inWorkspace(({ root }) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await mkdir(join(root, "real", "inner"), { recursive: true });
          await symlink("real/inner", join(root, "alias"));
          await symlink("../target.txt", join(root, "real", "inner", "l"));
        });

        yield* write("alias/l", "landed");

        expect(
          yield* Effect.promise(() => readFile(join(root, "real", "target.txt"), "utf8")),
        ).toBe("landed");
        expect((yield* Effect.promise(() => readdir(root))).sort()).toEqual(["alias", "real"]);
      }),
    ),
  );

  it.effect("refuses a link that goes up out of a folder another link leads outside", () =>
    inWorkspace(({ top, root, outside }) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await symlink(outside, join(root, "sub"));
          await symlink("sub/../y", join(root, "x"));
          await symlink("sub/..", join(root, "up"));
        });

        expect(yield* refusal(write("x", "planted"))).toBe("FileRefused");
        expect(yield* refusal(write("up/planted.txt", "planted"))).toBe("FileRefused");
        expect(yield* refusal(read("up/outside/secret.txt"))).toBe("FileRefused");
        expect(yield* refusal(list("up"))).toBe("FileRefused");
        expect((yield* Effect.promise(() => readdir(top))).sort()).toEqual([
          "outside",
          "workspace",
          "workspace-evil",
        ]);
        expect((yield* Effect.promise(() => readdir(root))).sort()).toEqual(["sub", "up", "x"]);
      }),
    ),
  );

  it.effect("follows a link that points back inside, for reads and writes", () =>
    inWorkspace(({ root }) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await mkdir(join(root, "reports"));
          await writeFile(join(root, "reports", "august.csv"), "a,b\n");
          await symlink("reports/august.csv", join(root, "latest.csv"));
        });

        expect((yield* read("latest.csv")).text).toBe("a,b\n");

        yield* write("latest.csv", "a,b\n1,2\n");

        expect(
          yield* Effect.promise(() => readFile(join(root, "reports", "august.csv"), "utf8")),
        ).toBe("a,b\n1,2\n");
        expect(
          (yield* Effect.promise(() => lstat(join(root, "latest.csv")))).isSymbolicLink(),
        ).toBe(true);
      }),
    ),
  );
});

describe("read_file", () => {
  it.effect("hands back the start of a long file, its whole size, and that it was cut", () =>
    inWorkspace(({ root }) =>
      Effect.gen(function* () {
        // A three-byte character straddles the cut, so the text ends before it, not in half of it.
        const text = `${"a".repeat(fileReadLimit - 1)}€ and more`;
        yield* Effect.promise(() => writeFile(join(root, "long.txt"), text));

        const start = yield* read("long.txt");

        expect(start.truncated).toBe(true);
        expect(start.bytes).toBe(Buffer.byteLength(text));
        expect(start.text).toBe("a".repeat(fileReadLimit - 1));
      }),
    ),
  );

  it.effect("fails on a folder or a file that is not there", () =>
    inWorkspace(({ root }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => mkdir(join(root, "reports")));

        expect(yield* refusal(read("reports"))).toBe("FileFailed");
        expect(yield* refusal(read("missing.txt"))).toBe("FileFailed");
      }),
    ),
  );
});

describe("write_file", () => {
  it.effect("creates the folders a file goes in", () =>
    inWorkspace(({ root }) =>
      Effect.gen(function* () {
        yield* write("reports/2026/summary.csv", "total,3\n");

        expect(
          yield* Effect.promise(() =>
            readFile(join(root, "reports", "2026", "summary.csv"), "utf8"),
          ),
        ).toBe("total,3\n");
      }),
    ),
  );

  it.effect("saves a file whose name is as long as a name may be", () =>
    inWorkspace(({ root }) =>
      Effect.gen(function* () {
        const name = `${"n".repeat(246)}.txt`;

        yield* write(name, "long");

        expect(yield* Effect.promise(() => readFile(join(root, name), "utf8"))).toBe("long");
      }),
    ),
  );

  it.effect("refuses more than a write may hold, writing nothing", () =>
    inWorkspace(({ root }) =>
      Effect.gen(function* () {
        expect(yield* refusal(write("big.txt", "x".repeat(fileWriteLimit + 1)))).toBe(
          "FileRefused",
        );
        expect(yield* Effect.promise(() => readdir(root))).toEqual([]);
      }),
    ),
  );
});

describe("list_files", () => {
  it.effect("lists every file and folder below, in name order, with each file's size", () =>
    inWorkspace(({ root, outside }) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await mkdir(join(root, "reports"));
          await writeFile(join(root, "reports", "august.csv"), "a,b\n");
          await writeFile(join(root, "notes.txt"), "hello");
          await symlink(outside, join(root, "elsewhere"));
        });

        expect(yield* list(".")).toEqual({
          action: "list_files",
          path: ".",
          entries: [
            { kind: "file", path: "notes.txt", bytes: 5 },
            { kind: "folder", path: "reports" },
            { kind: "file", path: "reports/august.csv", bytes: 4 },
          ],
          truncated: false,
        });
        expect((yield* list("reports")).action).toBe("list_files");
        expect(yield* refusal(list("notes.txt"))).toBe("FileFailed");
      }),
    ),
  );

  // Root reads a folder whatever its mode, so only a user without that power sees it unreadable.
  it.effect.skipIf(process.getuid?.() === 0)(
    "lists a folder it cannot open as unreadable, and everything else",
    () =>
      inWorkspace(({ root }) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await mkdir(join(root, "locked"));
            await writeFile(join(root, "locked", "hidden.txt"), "x");
            await writeFile(join(root, "notes.txt"), "hello");
            await chmod(join(root, "locked"), 0o000);
          });

          const listing = yield* list(".").pipe(
            Effect.ensuring(Effect.promise(() => chmod(join(root, "locked"), 0o755))),
          );

          expect(listing.entries).toEqual([
            { kind: "unreadable", path: "locked" },
            { kind: "file", path: "notes.txt", bytes: 5 },
          ]);
        }),
      ),
  );

  it.effect("stops at the most a listing may hold, and says so", () =>
    inWorkspace(({ root }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          Promise.all(
            Array.from({ length: fileListLimit + 1 }, (_, index) =>
              writeFile(join(root, `${String(index).padStart(4, "0")}.txt`), ""),
            ),
          ),
        );

        const listing = yield* list(".");

        expect(listing.entries).toHaveLength(fileListLimit);
        expect(listing.truncated).toBe(true);
      }),
    ),
  );
});

describe("a person's files", () => {
  it.effect("downloads the exact bytes of a file", () =>
    inWorkspace(({ root }) =>
      Effect.gen(function* () {
        const bytes = Uint8Array.from([0, 255, 10, 0, 128, 1]);
        yield* Effect.promise(() => writeFile(join(root, "blob.bin"), bytes));

        const download = yield* Workspace.use((workspace) => workspace.download("blob.bin"));
        const sent = yield* Stream.runCollect(download.body);

        expect(download.bytes).toBe(6);
        expect(Buffer.concat(sent)).toEqual(Buffer.from(bytes));
        expect(
          yield* refusal(Workspace.use((workspace) => workspace.download("../outside/secret.txt"))),
        ).toBe("FileRefused");
      }),
    ),
  );

  it.effect("uploads a file, and one that breaks off leaves what was there and nothing else", () =>
    inWorkspace(({ root }) =>
      Effect.gen(function* () {
        const upload = (body: Stream.Stream<Uint8Array, FileFailed>) =>
          Workspace.use((workspace) => workspace.upload("expenses.csv", body));

        expect(yield* upload(Stream.make(new TextEncoder().encode("a,1\n")))).toEqual({
          path: "expenses.csv",
          bytes: 4,
        });

        const brokenOff = Stream.make(new TextEncoder().encode("b,2\n")).pipe(
          Stream.concat(Stream.fail(new FileFailed({ message: "The upload broke off." }))),
        );

        expect(yield* refusal(upload(brokenOff))).toBe("FileFailed");
        expect(yield* Effect.promise(() => readdir(root))).toEqual(["expenses.csv"]);
        expect(yield* Effect.promise(() => readFile(join(root, "expenses.csv"), "utf8"))).toBe(
          "a,1\n",
        );
      }),
    ),
  );
});
