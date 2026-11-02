import type { BotSummary } from "@aobot/domain";
import { Option } from "effect";

/** One group heading in the sidebar and the Bots listed under it, in the order `bots.yaml` lists them. */
interface SidebarGroup {
  readonly name: string;
  readonly bots: ReadonlyArray<BotSummary>;
}

/**
How the sidebar lays out the Bots: the pinned ones in the grid on top, then the ones in no group, then
each group under its heading in the order the file first names it. A pinned Bot shows only in the grid.
*/
export interface SidebarSections {
  readonly pinned: ReadonlyArray<BotSummary>;
  readonly ungrouped: ReadonlyArray<BotSummary>;
  readonly groups: ReadonlyArray<SidebarGroup>;
}

/** The sidebar's sections for `bots`. */
export function sidebarSections(bots: ReadonlyArray<BotSummary>): SidebarSections {
  const listed = bots.filter((bot) => !bot.pinned);
  const names = [...new Set(listed.flatMap((bot) => Option.toArray(bot.group)))];

  return {
    pinned: bots.filter((bot) => bot.pinned),
    ungrouped: listed.filter((bot) => Option.isNone(bot.group)),
    groups: names.map((name) => ({
      name,
      bots: listed.filter((bot) => Option.contains(bot.group, name)),
    })),
  };
}
