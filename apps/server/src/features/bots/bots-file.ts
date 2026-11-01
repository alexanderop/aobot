import { BotId, ToolName } from "@aobot/domain";
import { Array, Effect, Option, Result, Schema } from "effect";
import { parseDocument } from "yaml";
import type { Bot } from "./bot.ts";

const BotEntry = Schema.Struct({
  id: BotId,
  name: Schema.NonEmptyString,
  group: Schema.OptionFromOptionalKey(Schema.NonEmptyString),
  pinned: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  instructions: Schema.NonEmptyString,
  tools: Schema.Array(ToolName),
}).check(
  Schema.makeFilter((entry) =>
    entry.pinned && Option.isSome(entry.group)
      ? { path: ["group"], issue: "a pinned Bot shows in the grid, so it takes no group" }
      : undefined,
  ),
);

const uniqueIds = Schema.makeFilter((entries: ReadonlyArray<typeof BotEntry.Type>) =>
  entries.flatMap((entry, index) =>
    entries.findIndex((other) => other.id === entry.id) < index
      ? [{ path: [index, "id"], issue: `${entry.id} names two Bots` }]
      : [],
  ),
);

/** `bots.yaml`: at least one Bot, each with an id no other Bot has. */
const BotsFile = Schema.Struct({
  bots: Schema.Array(BotEntry)
    .pipe(Schema.refine(Array.isReadonlyArrayNonEmpty, { message: "the file lists no Bot" }))
    .check(uniqueIds),
});

// A misspelt key, such as `tool:`, is an error rather than a setting silently left out.
const decodeBotsFile = Schema.decodeUnknownResult(BotsFile, {
  onExcessProperty: "error",
  errors: "all",
});

/** The file's YAML as plain values. `toJS` throws on a file that expands too far, such as an alias bomb. */
function parseYaml(text: string): Result.Result<unknown, string> {
  return Result.try({
    try: () => {
      const document = parseDocument(text);
      const [broken] = document.errors;

      if (broken !== undefined) throw broken;

      return document.toJS();
    },
    catch: (error) => (error instanceof Error ? error.message : String(error)),
  });
}

/**
The Bots `text` defines, in the order it lists them, or why it is not a valid bots file: empty, not YAML,
a field missing or of the wrong kind, a tool that does not exist, a pinned Bot in a group, two Bots with
one id, or no Bot at all. Every problem is named, not just the first.
*/
export function readBotsFile(
  text: string,
): Result.Result<Array.NonEmptyReadonlyArray<Bot>, string> {
  return parseYaml(text).pipe(
    Result.flatMap((contents) =>
      contents === null || contents === undefined
        ? Result.fail("the file is empty")
        : decodeBotsFile(contents).pipe(Result.mapError((error) => error.message)),
    ),
    Result.map(({ bots }) =>
      Array.map(bots, (entry) => ({ ...entry, tools: new Set(entry.tools) })),
    ),
  );
}
