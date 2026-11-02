import {
  actionLabel,
  AuditDecision,
  type AuditFilters,
  type AuditRow,
  type BotSummary,
  decisionLabel,
} from "@aobot/domain";
import { Option } from "effect";
import { filtersFromForm, noFilters, searchOf, toLocalInput } from "./audit-filters.ts";
import { whyOf } from "./why.ts";
import { useAuditTrail } from "./use-audit-trail.ts";
import "./audit.css";

const shownAt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

/** One audit row: when, for which Bot and person, what, how it was decided and why, and its trace. */
function Row(props: { readonly row: AuditRow; readonly botName: (id: string) => string }) {
  const { row } = props;
  const { rule, reason } = whyOf(row);

  return (
    <tr className="audit__row" data-action={row.action} data-decision={row.decision}>
      <td>
        <time dateTime={row.createdAt}>{shownAt.format(new Date(row.createdAt))}</time>
      </td>
      <td>{Option.match(row.bot, { onNone: () => "", onSome: props.botName })}</td>
      <td>
        {row.person}
        {row.initiatorKind === "deployment" ? (
          <span className="audit__muted"> by the server</span>
        ) : null}
      </td>
      <td title={row.action}>{actionLabel(row.action)}</td>
      <td className="audit__decision">{decisionLabel(row.decision)}</td>
      <td>
        <span className="audit__why">
          {Option.match(rule, {
            onNone: () => null,
            onSome: (name) => <code className="audit__rule">{name}</code>,
          })}
          {Option.match(reason, { onNone: () => null, onSome: (text) => <span>{text}</span> })}
        </span>
      </td>
      <td>
        {Option.match(row.traceUrl, {
          onNone: () => null,
          onSome: (href) => (
            <a className="audit__trace" href={href} target="_blank" rel="noopener noreferrer">
              Trace
            </a>
          ),
        })}
      </td>
    </tr>
  );
}

const shown = (value: Option.Option<string>) => Option.getOrElse(value, () => "");

/** The filter form, filled with `filters`. Filter shows what it asks for; Clear shows every row. */
function Filters(props: {
  readonly bots: ReadonlyArray<BotSummary>;
  readonly filters: AuditFilters;
  readonly filter: (next: AuditFilters) => void;
}) {
  const { filters } = props;
  const unlisted = Option.filter(filters.bot, (bot) => !props.bots.some(({ id }) => id === bot));

  return (
    <form
      className="audit__filters"
      aria-label="Filters"
      onSubmit={(event) => {
        event.preventDefault();
        props.filter(filtersFromForm(new FormData(event.currentTarget)));
      }}
    >
      <label className="audit__field">
        Bot
        <select name="bot" defaultValue={shown(filters.bot)}>
          <option value="">Any Bot</option>
          {props.bots.map((bot) => (
            <option key={bot.id} value={bot.id}>
              {bot.name}
            </option>
          ))}
          {Option.match(unlisted, {
            onNone: () => null,
            onSome: (bot) => <option value={bot}>{bot}</option>,
          })}
        </select>
      </label>
      <label className="audit__field">
        Person
        <input name="person" defaultValue={shown(filters.person)} placeholder="Anyone" />
      </label>
      <label className="audit__field">
        Decision
        <select name="decision" defaultValue={shown(filters.decision)}>
          <option value="">Any decision</option>
          {AuditDecision.literals.map((decision) => (
            <option key={decision} value={decision}>
              {decisionLabel(decision)}
            </option>
          ))}
        </select>
      </label>
      <label className="audit__field">
        From
        <input
          type="datetime-local"
          name="from"
          defaultValue={shown(Option.map(filters.from, toLocalInput))}
        />
      </label>
      <label className="audit__field">
        Before
        <input
          type="datetime-local"
          name="to"
          defaultValue={shown(Option.map(filters.to, toLocalInput))}
        />
      </label>
      <div className="audit__actions">
        <button type="submit" className="audit__button audit__button--accent">
          Filter
        </button>
        <button type="button" className="audit__button" onClick={() => props.filter(noFilters)}>
          Clear
        </button>
      </div>
    </form>
  );
}

/**
The audit trail, for security: every row newest first, filtered by Bot, person, decision and time, a page
at a time, each row linking to its trace.
*/
export function AuditPage(props: { readonly bots: ReadonlyArray<BotSummary> }) {
  const { filters, filter, rows, loading, more, problem, loadMore, reload } = useAuditTrail();

  const botName = (id: string) => props.bots.find((bot) => bot.id === id)?.name ?? id;

  return (
    <main className="audit">
      <header className="audit__header">
        <a className="audit__back" href="/">
          Back to the Bots
        </a>
        <h1 className="audit__title">Audit trail</h1>
      </header>
      <Filters key={searchOf(filters)} bots={props.bots} filters={filters} filter={filter} />
      <table className="audit__table">
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Bot</th>
            <th scope="col">Person</th>
            <th scope="col">Action</th>
            <th scope="col">Decision</th>
            <th scope="col">Why</th>
            <th scope="col">
              <span className="audit__hidden">Trace</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Row key={row.id} row={row} botName={botName} />
          ))}
        </tbody>
      </table>
      {Option.match(problem, {
        onNone: () => null,
        onSome: (message) => (
          <p className="audit__problem" role="alert">
            {message}
          </p>
        ),
      })}
      {Option.isSome(problem) && rows.length === 0 ? (
        <button type="button" className="audit__button" onClick={reload}>
          Try again
        </button>
      ) : null}
      {rows.length === 0 && !loading && Option.isNone(problem) ? (
        <p className="audit__muted">No rows match these filters.</p>
      ) : null}
      {loading ? (
        <p className="audit__muted" role="status">
          Loading…
        </p>
      ) : null}
      {more && !loading ? (
        <button type="button" className="audit__button audit__more" onClick={loadMore}>
          Load more
        </button>
      ) : null}
    </main>
  );
}
