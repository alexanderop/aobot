import type { BotId, BotSummary } from "@aobot/domain";
import { type MouseEvent, useId } from "react";
import { BotAvatar } from "./BotAvatar.tsx";
import { sidebarSections } from "./sidebar-sections.ts";
import "./sidebar.css";
import { usePausedBots } from "./use-pause.ts";

interface Picking {
  readonly selected: BotId;
  readonly paused: ReadonlyArray<BotId>;
  /** Where a Bot's link leads, for a click that opens it elsewhere: a new tab, a copied link. */
  readonly linkTo: (bot: BotId) => string;
  readonly onPick: (bot: BotId) => void;
}

/** A click the page handles itself; one with a modifier or another button opens the link as usual. */
function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

const avatarSize = { tile: 52, row: 32 } as const;

/** One Bot: a tile in the pinned grid, or a row under a group. A paused Bot says so under its name. */
function BotLink(props: Picking & { readonly bot: BotSummary; readonly layout: "tile" | "row" }) {
  const { bot } = props;
  const paused = props.paused.includes(bot.id);

  return (
    <li>
      <a
        href={props.linkTo(bot.id)}
        className={`sidebar__${props.layout}`}
        aria-current={bot.id === props.selected ? "page" : undefined}
        data-paused={paused}
        onClick={(event) => {
          if (!isPlainClick(event)) return;

          event.preventDefault();
          props.onPick(bot.id);
        }}
      >
        <BotAvatar bot={bot.id} size={avatarSize[props.layout]} />
        <span className="sidebar__label">
          <span className="sidebar__name" title={bot.name}>
            {bot.name}
          </span>
          {paused ? <span className="sidebar__paused">Paused</span> : null}
        </span>
      </a>
    </li>
  );
}

/** A group's heading and its Bots, one group for assistive technology, named by its heading. */
function Group(props: {
  readonly name: string;
  readonly bots: ReadonlyArray<BotSummary>;
  readonly picking: Picking;
}) {
  const heading = useId();

  return (
    <div className="sidebar__group" role="group" aria-labelledby={heading}>
      <h2 id={heading} className="sidebar__heading">
        {props.name}
      </h2>
      <ul className="sidebar__rows">
        {props.bots.map((bot) => (
          <BotLink key={bot.id} bot={bot} layout="row" {...props.picking} />
        ))}
      </ul>
    </div>
  );
}

/**
The Bots to talk to, as a messenger lists contacts: the pinned ones as a grid of large avatars, then a row
per Bot under each group's heading. The selected Bot's conversation is the one open beside it.
*/
export function Sidebar(
  props: Omit<Picking, "paused"> & { readonly bots: ReadonlyArray<BotSummary> },
) {
  const { pinned, ungrouped, groups } = sidebarSections(props.bots);

  const picking: Picking = {
    selected: props.selected,
    paused: usePausedBots(),
    linkTo: props.linkTo,
    onPick: props.onPick,
  };

  return (
    <nav className="sidebar" aria-label="Bots">
      {pinned.length === 0 ? null : (
        <ul className="sidebar__pinned" aria-label="Pinned">
          {pinned.map((bot) => (
            <BotLink key={bot.id} bot={bot} layout="tile" {...picking} />
          ))}
        </ul>
      )}
      {ungrouped.length === 0 ? null : (
        <ul className="sidebar__rows">
          {ungrouped.map((bot) => (
            <BotLink key={bot.id} bot={bot} layout="row" {...picking} />
          ))}
        </ul>
      )}
      {groups.map((group) => (
        <Group key={group.name} name={group.name} bots={group.bots} picking={picking} />
      ))}
    </nav>
  );
}
