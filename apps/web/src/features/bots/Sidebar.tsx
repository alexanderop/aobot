import type { BotId, BotSummary } from "@aobot/domain";
import { useId } from "react";
import { isPlainClick } from "../../shared/plain-click.ts";
import "../../shared/side-list.css";
import { BotAvatar } from "./BotAvatar.tsx";
import { sidebarSections } from "./sidebar-sections.ts";
import "./sidebar.css";
import { usePausedBots } from "./use-pause.ts";

interface Picking {
  readonly selected: BotId;
  /** Where a Bot's link leads, for a click that opens it elsewhere: a new tab, a copied link. */
  readonly linkTo: (bot: BotId) => string;
  readonly onPick: (bot: BotId) => void;
}

const avatarSize = { tile: 52, row: 32 } as const;

/** One Bot: a tile in the pinned grid, or a row under a group. A paused Bot says so under its name. */
function BotLink(
  props: Picking & {
    readonly bot: BotSummary;
    readonly layout: "tile" | "row";
    readonly paused: boolean;
  },
) {
  const { bot, paused } = props;

  return (
    <li>
      <a
        href={props.linkTo(bot.id)}
        className={props.layout === "tile" ? "side-row sidebar__tile" : "side-row"}
        aria-current={bot.id === props.selected ? "page" : undefined}
        data-paused={paused}
        onClick={(event) => {
          if (!isPlainClick(event)) return;

          event.preventDefault();
          props.onPick(bot.id);
        }}
      >
        <BotAvatar bot={bot.id} size={avatarSize[props.layout]} />
        <span className="side-row__label">
          <span className="side-row__text" title={bot.name}>
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
  readonly paused: ReadonlyArray<BotId>;
  readonly picking: Picking;
}) {
  const heading = useId();

  return (
    <div className="sidebar__group" role="group" aria-labelledby={heading}>
      <h2 id={heading} className="side-heading">
        {props.name}
      </h2>
      <ul className="side-list">
        {props.bots.map((bot) => (
          <BotLink
            key={bot.id}
            bot={bot}
            layout="row"
            paused={props.paused.includes(bot.id)}
            {...props.picking}
          />
        ))}
      </ul>
    </div>
  );
}

/**
The Bots to talk to, as a messenger lists contacts: the pinned ones as a grid of large avatars, then a row
per Bot under each group's heading. The selected Bot's conversation is the one open beside it.
*/
export function Sidebar(props: Picking & { readonly bots: ReadonlyArray<BotSummary> }) {
  const { pinned, ungrouped, groups } = sidebarSections(props.bots);
  const picking: Picking = { selected: props.selected, linkTo: props.linkTo, onPick: props.onPick };
  const paused = usePausedBots();

  return (
    <nav className="sidebar" aria-label="Bots">
      {pinned.length === 0 ? null : (
        <ul className="side-list sidebar__pinned" aria-label="Pinned">
          {pinned.map((bot) => (
            <BotLink
              key={bot.id}
              bot={bot}
              layout="tile"
              paused={paused.includes(bot.id)}
              {...picking}
            />
          ))}
        </ul>
      )}
      {ungrouped.length === 0 ? null : (
        <ul className="side-list">
          {ungrouped.map((bot) => (
            <BotLink
              key={bot.id}
              bot={bot}
              layout="row"
              paused={paused.includes(bot.id)}
              {...picking}
            />
          ))}
        </ul>
      )}
      {groups.map((group) => (
        <Group
          key={group.name}
          name={group.name}
          bots={group.bots}
          paused={paused}
          picking={picking}
        />
      ))}
    </nav>
  );
}
