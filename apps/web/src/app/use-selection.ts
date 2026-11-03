import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { Option } from "effect";
import type { Choice, Selection } from "./selection.ts";
import { selection } from "./selection-atoms.ts";

/**
The Bot and conversation the page has open, once the server said which Bots there are, and `choose` to
open another. The URL follows the selection, so a reload opens it again.
*/
export function useSelection(): readonly [Option.Option<Selection>, (choice: Choice) => void] {
  return [useAtomValue(selection), useAtomSet(selection)];
}
