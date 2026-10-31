import { Avatar, characters } from "./Avatar.tsx";
import { groups, pinned, selected } from "./bots.ts";
import type { SidebarBot } from "./bots.ts";
import "./planned.css";

function SearchIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function AppsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.6" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6" />
    </svg>
  );
}

function Pinned(props: { readonly bot: SidebarBot }) {
  return (
    <li>
      <button type="button" className="pin">
        <span className="pin__avatar">
          <Avatar character={characters[props.bot.character]} size={64} />
          {props.bot.unread ? (
            <span className="unread unread--on-avatar" role="img" aria-label="Unread" />
          ) : null}
        </span>
        <span className="pin__name">{props.bot.name}</span>
      </button>
    </li>
  );
}

function Row(props: { readonly bot: SidebarBot }) {
  const active = props.bot.name === selected;

  return (
    <li>
      <button
        type="button"
        className={active ? "row row--active" : "row"}
        aria-current={active ? "true" : undefined}
      >
        <Avatar character={characters[props.bot.character]} size={40} />
        <span className="row__text">
          <span className="row__name">{props.bot.name}</span>
          <span className="row__preview">{props.bot.preview}</span>
        </span>
        {props.bot.unread ? <span className="unread" role="img" aria-label="Unread" /> : null}
      </button>
    </li>
  );
}

/** Planned in E2-1 (groups, pinned Bots, avatars) and E3-2 (previews, unread dots): the list of Bots beside the conversation. */
export function Sidebar() {
  return (
    <nav className="sidebar" aria-label="Bots">
      <div className="sidebar__top">
        <button type="button" className="round-button" aria-label="Search">
          <SearchIcon />
        </button>
        <button type="button" className="round-button" aria-label="New Bot">
          <PlusIcon />
        </button>
      </div>
      <div className="sidebar__scroll">
        <ul className="pins">
          {pinned.map((bot) => (
            <Pinned key={bot.name} bot={bot} />
          ))}
        </ul>
        {groups.map((group) => (
          <section key={group.title} className="group">
            <h2 className="group__title">{group.title}</h2>
            <ul className="group__rows">
              {group.bots.map((bot) => (
                <Row key={bot.name} bot={bot} />
              ))}
            </ul>
          </section>
        ))}
      </div>
      <footer className="me">
        <span className="me__photo" aria-hidden="true">
          A
        </span>
        <span className="me__name">Alexander</span>
        <button type="button" className="round-button round-button--quiet" aria-label="Apps">
          <AppsIcon />
        </button>
      </footer>
    </nav>
  );
}
