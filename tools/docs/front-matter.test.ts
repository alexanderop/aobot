import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { parse } from "yaml";
import { describe, expect, it } from "vite-plus/test";

const docs = fileURLToPath(new URL("../../docs/", import.meta.url));

const PageFrontMatter = Schema.Struct({
  title: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
});

const decodePage = Schema.decodeUnknownSync(PageFrontMatter);

function markdownFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);

    if (entry.isDirectory()) return markdownFiles(path);

    return entry.name.endsWith(".md") ? [path] : [];
  });
}

const pages = markdownFiles(docs).map((path) => relative(docs, path));

describe("every page the docs site renders", () => {
  it.each(pages)("%s has a title and a description", (page) => {
    const text = readFileSync(join(docs, page), "utf8");
    const header = /^---\n([\s\S]*?)\n---/u.exec(text)?.[1] ?? "";

    expect(() => decodePage(parse(header))).not.toThrow();
  });
});
