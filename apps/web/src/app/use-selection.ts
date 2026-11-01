import type { BotId } from "@aobot/domain";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { Option } from "effect";
import type { Selection } from "./selection.ts";
import { selection } from "./selection-atoms.ts";

/**
The Bot and conversation the page has open, once the server said which Bots there are, and `pick` to open
another Bot. The URL follows the selection, so a reload opens it again.
*/
export function useSelection(): readonly [Option.Option<Selection>, (bot: BotId) => void] {
  return [useAtomValue(selection), useAtomSet(selection)];
}
