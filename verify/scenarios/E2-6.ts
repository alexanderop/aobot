import { Schema } from "effect";
import { ModelStep, refTo } from "../../apps/server/src/features/agent/testing/model-script.ts";
import { assert, browser, evaluate, waitFor } from "../browser.ts";
import {
  answers,
  ask,
  auditRows,
  cardResult,
  failedCards,
  modelRequests,
  script,
} from "../chat.ts";
import { panelState, panelText } from "../screen.ts";
import { attribute, gatewayActSpan, type TempoSpan, traceSpans } from "../tempo.ts";

const accountPage = "http://fixture:8080/account";

const handOff =
  "click did not run: entering or changing a password, one-time code or other credential is always your person's to do, never a Bot's, whatever the rules say.";

const report =
  "Changing a password is yours to do. Please take control of my computer and change it yourself.";

const HandOffDetail = Schema.fromJsonString(
  Schema.Struct({
    bot: Schema.String,
    role: Schema.String,
    name: Schema.String,
    host: Schema.String,
    path: Schema.String,
    safety: Schema.String,
    rule: Schema.optional(Schema.Unknown),
  }),
);

const ShownRows = Schema.Array(
  Schema.Struct({ decision: Schema.String, shown: Schema.String, why: Schema.String }),
);

/** Every row the audit page shows, as a person reads it. */
function shownRows() {
  return evaluate(
    ShownRows,
    `[...document.querySelectorAll(".audit__row")].map((row) => ({
      decision: row.dataset.decision,
      shown: row.cells[3].textContent + " · " + row.cells[4].textContent,
      why: row.cells[5].textContent,
    }))`,
  );
}

/**
E2-6: rules.yaml allows every granted tool (`granted-tools`, `when: "true"`). Asked to change the password
on the fixture's `/account`, the Bot opens it and clicks Change password. The safety list hands the click
to the person before any rule is read: the computer never clicks, the click card and the model read that it
is the person's to do and that they should take control, the audit has `click · hand_off` naming
`safety: credentials` and no rule, and the audit page reads it as `Click · Handed to the person` with
`safety:credentials`. The folded panel offers Take control, which gives the person the computer. The
Gateway.act span in Tempo has `decision.source = safety`.
*/
export default async function scenario(baseUrl: string, grafanaUrl: string): Promise<void> {
  await script([
    ModelStep.CallTools({ calls: [{ name: "navigate", params: { url: accountPage } }] }),
    ModelStep.CallTools({
      calls: [{ name: "click", params: { ref: refTo("button", "Change password") } }],
    }),
    ModelStep.Say({ words: report.split(/(?= )/u) }),
  ]);

  browser("open", baseUrl);
  browser("wait", "--load", "networkidle");
  // The rail's button slides while the panel folds, and a click mid-slide lands beside it.
  browser("set", "media", "dark", "reduced-motion");

  await ask("Change the password on the account page to a new one.", 0, report);

  await waitFor("the click card to fail", 10_000, () => failedCards("click") === 1);
  assert(
    cardResult("click").includes(handOff) && cardResult("click").includes("take control"),
    `the click card says the change is the person's, and to take control (${cardResult("click")})`,
  );
  assert(
    (await modelRequests()).at(-1)?.includes(handOff) === true,
    "the model read that the click is its person's to do",
  );
  assert(answers()[0] === report, "Assistant asked its person to take control");

  const rows = auditRows();
  const trail = rows.map((row) => `${row.action} · ${row.decision}`);
  assert(
    trail.join(", ") === "navigate · allow, navigate · succeeded, click · hand_off",
    `the click is handed off, never allowed or forwarded (${trail.join(", ")})`,
  );

  const handedOff = rows.find((row) => row.decision === "hand_off");
  const detail = Schema.decodeUnknownSync(HandOffDetail)(handedOff?.detail);
  assert(
    detail.safety === "credentials" &&
      detail.rule === undefined &&
      detail.role === "button" &&
      detail.name === "Change password" &&
      detail.host === "fixture" &&
      detail.path === "/account",
    `click · hand_off names safety:credentials and no rule (${handedOff?.detail})`,
  );

  await waitFor("the panel to fold once the turn ended", 30_000, () => panelState() === "folded");
  browser("find", "role", "button", "click", "--name", "Take control");
  await waitFor(
    "the person to hold the computer",
    30_000,
    () => panelState() === "open" && panelText().includes("You have control."),
  );

  browser("find", "role", "link", "click", "--name", "Audit trail");
  await waitFor("the audit page to show the hand-off", 30_000, () =>
    shownRows().some((row) => row.decision === "hand_off"),
  );

  const shown = shownRows().find((row) => row.decision === "hand_off");
  assert(
    shown?.shown === "Click · Handed to the person" && shown.why === "safety:credentials",
    `the audit page reads Click · Handed to the person, decided by safety:credentials (${JSON.stringify(shown)})`,
  );

  const traceId = handedOff?.trace_id ?? "";
  assert(traceId !== "", "the hand_off row carries the turn's trace_id");

  let spans: ReadonlyArray<TempoSpan> = [];

  await waitFor("the click Gateway.act span in Tempo", 60_000, async () => {
    spans = await traceSpans(grafanaUrl, traceId).catch(() => []);

    return gatewayActSpan(spans, "click") !== undefined;
  });

  const click = gatewayActSpan(spans, "click");
  assert(
    click !== undefined &&
      attribute(click, "decision.source") === "safety" &&
      attribute(click, "gateway.decision") === "hand_off" &&
      attribute(click, "gateway.safety") === "credentials" &&
      attribute(click, "gateway.rule") === undefined,
    `the click span records the safety list, not a rule (${JSON.stringify(click?.attributes)})`,
  );
}
