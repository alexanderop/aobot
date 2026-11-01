import { Schema } from "effect";

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
