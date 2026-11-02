import { Schema } from "effect";
import { ModelStep } from "../../apps/server/src/features/agent/testing/model-script.ts";
import { assert, browser, waitFor } from "../browser.ts";
import {
  answers,
  ask,
  auditRows,
  cardResult,
  failedCards,
  modelRequests,
  script,
} from "../chat.ts";
import { attribute, gatewayActSpan, type TempoSpan, traceSpans } from "../tempo.ts";

const DenyDetail = Schema.fromJsonString(
  Schema.Struct({
    bot: Schema.String,
    command: Schema.String,
    rule: Schema.String,
    reason: Schema.String,
  }),
);

const refusal = "run did not run: the rule no-rm-rf refuses it.";

const report = "I did not run it: the rule no-rm-rf refuses it.";

/**
E2-2: rules.yaml denies `rm -rf` in a command. Assistant, granted run in bots.yaml, is asked to run
`rm -rf /tmp/x`. The rule refuses it before the computer hears of it: the transcript and the model read
which rule refused it, the audit has one `run · deny · no-rm-rf` and no allow row, and the Gateway.act span
in Tempo records the decision and the rule.
*/
export default async function scenario(baseUrl: string, grafanaUrl: string): Promise<void> {
  await script([
    ModelStep.CallTools({ calls: [{ name: "run", params: { command: "rm -rf /tmp/x" } }] }),
    ModelStep.Say({ words: report.split(/(?= )/u) }),
  ]);

  browser("open", baseUrl);
  browser("wait", "--load", "networkidle");

  await ask("Run rm -rf /tmp/x in your workspace.", 0, report);

  await waitFor("the run card to fail", 10_000, () => failedCards("run") === 1);
  assert(
    cardResult("run").includes(refusal),
    `the transcript shows the refusal naming the rule (${cardResult("run")})`,
  );
  assert(
    (await modelRequests()).at(-1)?.includes(refusal) === true,
    "the model read which rule refused run",
  );
  assert(answers()[0] === report, "Assistant reported the refusal and named the rule");

  const rows = auditRows();
  assert(
    rows.length === 1 && rows[0]?.action === "run" && rows[0].decision === "deny",
    `the audit has one run · deny and no allow row (${JSON.stringify(rows)})`,
  );
  const denied = Schema.decodeUnknownSync(DenyDetail)(rows[0].detail);
  assert(
    denied.rule === "no-rm-rf" && denied.reason === "denied by rule" && denied.bot === "assistant",
    `the audit row reads run · deny · no-rm-rf for assistant (${rows[0].detail})`,
  );
  assert(denied.command === "rm -rf /tmp/x", "the deny row keeps the command it refused");

  const traceId = rows[0].trace_id ?? "";
  assert(traceId !== "", "the deny row carries the turn's trace_id");

  let spans: ReadonlyArray<TempoSpan> = [];

  await waitFor("the run Gateway.act span in Tempo", 60_000, async () => {
    spans = await traceSpans(grafanaUrl, traceId).catch(() => []);

    return gatewayActSpan(spans, "run") !== undefined;
  });

  const run = gatewayActSpan(spans, "run");

  assert(
    run !== undefined &&
      attribute(run, "gateway.decision") === "deny" &&
      attribute(run, "gateway.rule") === "no-rm-rf",
    `the run span records the decision and the rule (${JSON.stringify(run?.attributes)})`,
  );
}
