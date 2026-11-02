import { BotId, type BotSummary } from "@aobot/domain";
import { Option } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { sidebarSections } from "./sidebar-sections.ts";

function bot(
  id: string,
  place: { readonly pinned?: boolean; readonly group?: string },
): BotSummary {
  return {
    id: BotId.make(id),
    name: id,
    group: Option.fromUndefinedOr(place.group),
    pinned: place.pinned ?? false,
  };
}

const ids = (bots: ReadonlyArray<BotSummary>) => bots.map((summary) => summary.id);

describe("sidebarSections", () => {
  it("puts pinned Bots in the grid, then loose ones, then each group in the order the file names it", () => {
    const sections = sidebarSections([
      bot("assistant", { pinned: true }),
      bot("coach", { group: "fitness" }),
      bot("researcher", { group: "research" }),
      bot("scribe", { pinned: true, group: "research" }),
      bot("planner", { group: "fitness" }),
      bot("loner", {}),
    ]);

    expect(ids(sections.pinned)).toEqual(["assistant", "scribe"]);
    expect(ids(sections.ungrouped)).toEqual(["loner"]);
    expect(sections.groups.map((group) => [group.name, ids(group.bots)])).toEqual([
      ["fitness", ["coach", "planner"]],
      ["research", ["researcher"]],
    ]);
  });
});
