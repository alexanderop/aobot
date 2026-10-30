import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { parse } from "yaml";
import { describe, expect, it } from "vite-plus/test";
import { policyProblems } from "../oxlint/aobot-architecture/policy.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

const backlog = join(root, "docs/backlog");

const FrontMatter = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  epic: Schema.String,
  status: Schema.Literals(["todo", "doing", "done"]),
  depends_on: Schema.Array(Schema.String),
  estimate: Schema.String,
});

const decodeFrontMatter = Schema.decodeUnknownSync(FrontMatter);

interface Ticket extends Schema.Schema.Type<typeof FrontMatter> {
  readonly file: string;
  readonly folder: string;
}

function readTickets(): readonly Ticket[] {
  return readdirSync(backlog, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((folder) =>
      readdirSync(join(backlog, folder.name))
        .filter((file) => file !== "README.md" && file.endsWith(".md"))
        .map((file) => {
          const text = readFileSync(join(backlog, folder.name, file), "utf8");
          const header = /^---\n([\s\S]*?)\n---/u.exec(text)?.[1] ?? "";

          return { ...decodeFrontMatter(parse(header)), file, folder: folder.name };
        }),
    );
}

const tickets = readTickets();

const ids = new Set(tickets.map((ticket) => ticket.id));

describe("the backlog", () => {
  it("has tickets", () => {
    expect(tickets.length).toBeGreaterThan(0);
  });

  it.each(tickets.map((ticket) => [ticket.id, ticket] as const))(
    "%s sits in its epic folder and is named by its id",
    (_id, ticket) => {
      expect(ticket.file.startsWith(`${ticket.id}-`)).toBe(true);
      expect(ticket.folder.startsWith(`${ticket.epic}-`)).toBe(true);
    },
  );

  it("uses each id once", () => {
    expect(ids.size).toBe(tickets.length);
  });

  it("only depends on tickets that exist, without cycles", () => {
    const graph = new Map(tickets.map((ticket) => [ticket.id, ticket.depends_on]));
    expect(policyProblems(graph, "backlog")).toEqual([]);
  });

  it("proves every done ticket with a verify scenario", () => {
    const unproven = tickets
      .filter((ticket) => ticket.status === "done")
      .filter((ticket) => !existsSync(join(root, "verify/scenarios", `${ticket.id}.ts`)))
      .map((ticket) => ticket.id);

    expect(unproven).toEqual([]);
  });
});
