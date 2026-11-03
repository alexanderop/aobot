import { Schema } from "effect";
import { ModelStep } from "../../apps/server/src/features/agent/testing/model-script.ts";
import { assert, browser, evaluate, waitFor } from "../browser.ts";
import { ask, auditRows, everyAuditRow, script } from "../chat.ts";
import { gatewayActSpan, traceSpans } from "../tempo.ts";

const ShownRows = Schema.Array(
  Schema.Struct({
    action: Schema.String,
    decision: Schema.String,
    bot: Schema.String,
    shown: Schema.String,
    why: Schema.String,
    trace: Schema.NullOr(Schema.String),
  }),
);

const DenyDetail = Schema.fromJsonString(Schema.Struct({ bot: Schema.String }));

/** Every row the audit page shows, as a person reads it, with its Trace link. */
function shownRows() {
  return evaluate(
    ShownRows,
    `[...document.querySelectorAll(".audit__row")].map((row) => ({
      action: row.dataset.action,
      decision: row.dataset.decision,
      bot: row.cells[1].textContent,
      shown: row.cells[3].textContent + " · " + row.cells[4].textContent,
      why: row.cells[5].textContent,
      trace: row.querySelector("a.audit__trace")?.href ?? null,
    }))`,
  );
}

/** The trace a Grafana Explore link opens, as its `panes` names it. */
function tracedBy(link: string): string {
  const panes = new URL(link).searchParams.get("panes") ?? "";

  return Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        trace: Schema.Struct({ queries: Schema.Tuple([Schema.Struct({ query: Schema.String })]) }),
      }),
    ),
  )(panes).trace.queries[0].query;
}

/** Picks `value` in the filter form's `name` field and filters, then waits until the URL says so. */
async function filterOn(name: string, value: string): Promise<void> {
  browser("select", `.audit__filters select[name="${name}"]`, value);
  browser("find", "role", "button", "click", "--name", "Filter");

  await waitFor(
    `the URL to keep ${name}=${value}`,
    10_000,
    () => new URL(browser("get", "url")).searchParams.get(name) === value,
  );
}

/**
E2-4: the E2-1 and E2-2 refusals beside an allowed call, then the audit page. Assistant is refused rm -rf
by the rule no-rm-rf and then runs ls, Researcher is refused run because it was not granted it. The page
shows every row; filtered on Refused, only the two refusals, newest first, with their Bots and why, and a
reload keeps the filter. Each links to its own trace in Grafana, which opens it. Filtered on Researcher
too, it shows only Researcher's.
*/
export default async function scenario(baseUrl: string, grafanaUrl: string): Promise<void> {
  browser("open", baseUrl);
  browser("wait", "--load", "networkidle");

  await script([
    ModelStep.CallTools({ calls: [{ name: "run", params: { command: "rm -rf /tmp/x" } }] }),
    ModelStep.Say({ words: ["I", " did", " not", " run", " it."] }),
  ]);
  await ask("Run rm -rf /tmp/x in your workspace.", 0, "I did not run it.");

  await script([
    ModelStep.CallTools({ calls: [{ name: "run", params: { command: "ls" } }] }),
    ModelStep.Say({ words: ["I", " listed", " it."] }),
  ]);
  await ask("Run ls in your workspace.", 1, "I listed it.");

  await script([
    ModelStep.CallTools({ calls: [{ name: "run", params: { command: "ls" } }] }),
    ModelStep.Say({ words: ["I", " may", " not", " run", " commands."] }),
  ]);
  browser("find", "role", "link", "click", "--name", "Researcher");
  await waitFor("Researcher's conversation to open", 10_000, () =>
    browser("get", "url").includes("bot=researcher"),
  );
  await ask("Run ls in your workspace.", 0, "I may not run commands.", "Researcher");

  const stored = auditRows();
  const refusals = stored.filter(({ decision }) => decision === "deny");
  assert(
    refusals.length === 2 &&
      stored.some((row) => row.action === "run" && row.decision === "allow") &&
      stored.some((row) => row.action === "run" && row.decision === "succeeded"),
    `the audit has the two refusals, and the allowed ls and its outcome (${JSON.stringify(stored)})`,
  );

  const traceOf = new Map(
    refusals.map((row) => [
      Schema.decodeUnknownSync(DenyDetail)(row.detail).bot,
      row.trace_id ?? "",
    ]),
  );

  browser("find", "role", "link", "click", "--name", "Audit trail");
  const everyRow = everyAuditRow().length;
  await waitFor(
    `the audit page to show all ${everyRow} rows`,
    30_000,
    () => shownRows().length === everyRow,
  );

  await filterOn("decision", "deny");
  await waitFor("the page to show only the two refusals", 10_000, () => {
    const rows = shownRows();

    return rows.length === 2 && rows.every(({ decision }) => decision === "deny");
  });

  const [newest, older] = shownRows();
  assert(
    newest?.bot === "Researcher" &&
      newest.shown === "Run a command · Refused" &&
      newest.why.includes("not granted to researcher"),
    `the newest row is Researcher's run · Refused, not granted (${JSON.stringify(newest)})`,
  );
  assert(
    older?.bot === "Assistant" &&
      older.shown === "Run a command · Refused" &&
      older.why.includes("no-rm-rf"),
    `the row before it is Assistant's run · Refused by no-rm-rf (${JSON.stringify(older)})`,
  );

  for (const [row, bot] of [
    [newest, "researcher"],
    [older, "assistant"],
  ] as const) {
    const link = row.trace ?? "";

    assert(
      link.startsWith(`${grafanaUrl}/explore?`) && tracedBy(link) === traceOf.get(bot),
      `${bot}'s row links to its own trace in Grafana (${link})`,
    );
  }

  browser("reload");
  await waitFor("the reloaded page to show only the two refusals", 30_000, () => {
    const rows = shownRows();

    return rows.length === 2 && rows.every(({ decision }) => decision === "deny");
  });
  assert(
    new URL(browser("get", "url")).searchParams.get("decision") === "deny",
    "the reloaded URL keeps decision=deny",
  );

  const decisionShown = evaluate(
    Schema.String,
    `document.querySelector('.audit__filters select[name="decision"]').selectedOptions[0].textContent`,
  );

  assert(decisionShown === "Refused", `the reloaded form shows Refused (${decisionShown})`);

  await filterOn("bot", "researcher");
  await waitFor("the page to show only Researcher's refusal", 10_000, () => {
    const rows = shownRows();

    return rows.length === 1 && rows[0]?.bot === "Researcher";
  });

  // Explore asks Tempo once, so the link is opened only once Tempo holds the trace.
  await waitFor("the refused run's Gateway.act span in Tempo", 60_000, async () => {
    const spans = await traceSpans(grafanaUrl, traceOf.get("assistant") ?? "").catch(() => []);

    return gatewayActSpan(spans, "run") !== undefined;
  });

  browser("open", older.trace ?? "");
  await waitFor("Grafana to show the refused run's trace", 60_000, () =>
    browser("get", "text", "body").includes("Gateway.act"),
  );
  console.log(
    "ok: the Trace link opens the turn's trace in Grafana, its Gateway.act span included",
  );
}
