import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { escapesWorkspace, FileAction, fileName } from "./computer.ts";

describe("escapesWorkspace", () => {
  it.each([
    "notes.txt",
    "reports/august.csv",
    "",
    ".",
    "./notes.txt",
    "..notes",
    "notes..txt",
    "c:notes.txt",
    "\\etc\\passwd",
    "a\\..\\x",
  ])("keeps %j inside the workspace, as Linux reads it", (path) => {
    expect(escapesWorkspace(path)).toBe(false);
  });

  it.each(["/etc/passwd", "/workspace/notes.txt", "..", "../x", "a/../../x"])(
    "takes %j outside it",
    (path) => {
      expect(escapesWorkspace(path)).toBe(true);
    },
  );
});

describe("fileName", () => {
  it.each([
    ["reports/august.csv", "august.csv"],
    ["reports/", "reports"],
    ["a\\b.txt", "a\\b.txt"],
  ])("names %j %j", (path, name) => {
    expect(fileName(path)).toBe(name);
  });
});

describe("FileAction", () => {
  const decode = Schema.decodeUnknownSync(FileAction);

  it("names the workspace itself . when its path is empty", () => {
    expect(decode({ action: "list_files", path: "" })).toEqual({ action: "list_files", path: "." });
  });

  it("keeps a path as it is written, spaces and all", () => {
    expect(decode({ action: "read_file", path: " a.txt " })).toEqual({
      action: "read_file",
      path: " a.txt ",
    });
  });
});
