import { describe, expect, it } from "vite-plus/test";
import { fileTarget } from "./file-target.ts";

describe("fileTarget", () => {
  it.each([
    ["expenses.csv", { path: "expenses.csv", name: "expenses.csv", extension: "csv" }],
    [
      "reports/2026/Summary.CSV",
      { path: "reports/2026/Summary.CSV", name: "Summary.CSV", extension: "csv" },
    ],
    ["archive.tar.gz", { path: "archive.tar.gz", name: "archive.tar.gz", extension: "gz" }],
    ["Makefile", { path: "Makefile", name: "Makefile", extension: "" }],
    [".env", { path: ".env", name: ".env", extension: "" }],
    ["/etc/passwd", { path: "/etc/passwd", name: "passwd", extension: "" }],
    ["notes\\draft.txt", { path: "notes\\draft.txt", name: "notes\\draft.txt", extension: "txt" }],
  ])("names %j by its path, name and extension", (path, target) => {
    expect(fileTarget(path)).toEqual(target);
  });
});
