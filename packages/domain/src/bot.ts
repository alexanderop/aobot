import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { BotId } from "./ids.ts";

/**
The tools a Bot can be offered, by the name the model calls them. A grant in `bots.yaml` names some of
them; a name not listed here fails the file.
*/
export const ToolName = Schema.Literals([
  "navigate",
  "snapshot",
  "click",
  "type",
  "run",
  "read_file",
  "write_file",
  "list_files",
]);

/** A decoded {@link ToolName}. */
export type ToolName = typeof ToolName.Type;

/**
What the page shows about a Bot: its name and avatar in the sidebar, the header pill and the composer
placeholder, and where the sidebar lists it. The avatar is drawn from its id.
*/
export const BotSummary = Schema.Struct({
  id: BotId,
  name: Schema.String,
  group: Schema.OptionFromOptionalKey(Schema.String),
  pinned: Schema.Boolean,
});

/** A decoded {@link BotSummary}. */
export type BotSummary = typeof BotSummary.Type;

/** No Bot has this id: it is not in the server's `bots.yaml`, or no longer is. */
export class UnknownBot extends Schema.TaggedError<UnknownBot>()("UnknownBot", {
  botId: BotId,
}) {}

/** The Bots the server knows, in the order `bots.yaml` lists them, so the first is the page's default. */
export class BotRpcs extends RpcGroup.make(
  Rpc.make("Bots.list", { success: Schema.NonEmptyArray(BotSummary) }),
) {}
