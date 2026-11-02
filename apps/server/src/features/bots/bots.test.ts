import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { Bots, botsFileLayer } from "./bots.ts";

/** Builds {@link Bots} from the file at `path`, as a server start does, and answers why it failed. */
const startFailure = (path: string) =>
  Effect.flip(
    Layer.build(botsFileLayer(path).pipe(Layer.provide(NodeFileSystem.layer))).pipe(Effect.scoped),
  );

function writtenFile(text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "aobot-bots-")), "bots.yaml");
  writeFileSync(path, text);

  return path;
}

describe("botsFileLayer", () => {
  it.effect("stops start-up naming the file when there is none", () =>
    Effect.gen(function* () {
      const missing = join(tmpdir(), "aobot-no-such-dir", "bots.yaml");
      const error = yield* startFailure(missing);

      expect(error.message).toContain(`${missing} is not a valid bots file: `);
    }),
  );

  it.effect("stops start-up naming the file and why it is not valid", () =>
    Effect.gen(function* () {
      const path = writtenFile("bots: []\n");
      const error = yield* startFailure(path);

      expect(error.message).toBe(
        `${path} is not a valid bots file: the file lists no Bot\n  at ["bots"]`,
      );
    }),
  );

  it.effect("serves the Bots a valid file lists", () =>
    Effect.gen(function* () {
      const path = writtenFile(`bots:
  - id: assistant
    name: Assistant
    instructions: You are Assistant.
    tools: [run]
`);

      const ids = yield* Bots.use((bots) => Effect.succeed(bots.list.map((bot) => bot.id))).pipe(
        Effect.provide(botsFileLayer(path).pipe(Layer.provide(NodeFileSystem.layer))),
      );

      expect(ids).toEqual(["assistant"]);
    }),
  );
});
