import { Schema } from "effect";
import { ModelStep } from "../../apps/server/src/features/agent/testing/model-script.ts";
import { assert, browser, waitFor } from "../browser.ts";
import { answers, ask, auditRows, doneCards, modelRequests, script } from "../chat.ts";
import { ancestry, attribute, traceSpans } from "../tempo.ts";

const makeNotes = "echo hello > notes.txt && ls";

const readDatabase = "ls /data/aobot.db";

const reachServer = "curl --silent --show-error --fail-with-body --max-time 3 http://server:3000";

const CommandDetail = Schema.fromJsonString(Schema.Struct({ command: Schema.String }));

const CardTexts = Schema.fromJsonString(Schema.Array(Schema.String));

function runOutputs(): ReadonlyArray<string> {
  return Schema.decodeUnknownSync(CardTexts)(
    browser(
      "eval",
      `[...document.querySelectorAll('.tool-call[data-tool="run"] .tool-call__result')].map((node) => node.textContent)`,
    ),
  );
}

/**
E1-3: asked to create notes.txt and list the folder, the Bot runs one command in its workspace and the
transcript shows notes.txt in what it printed. The command is audited and traced with how it ended. From
the same shell, the server's database is not there to read, and a command that honours the proxy settings
the computer gives it cannot reach the server. A command that bypasses them is E5-3.
*/
export default async function scenario(baseUrl: string, grafanaUrl: string): Promise<void> {
  await script([
    ModelStep.CallTools({ calls: [{ name: "run", params: { command: makeNotes } }] }),
    ModelStep.Say({ words: ["I", " made", " notes.txt", " and", " listed", " the", " folder."] }),
  ]);

  browser("open", baseUrl);
  browser("wait", "--load", "networkidle");

  await ask(
    "Create notes.txt containing hello, then list the folder.",
    0,
    "I made notes.txt and listed the folder.",
  );

  await waitFor("the run card to be done", 10_000, () => doneCards("run") === 1);

  const [listed = ""] = runOutputs();
  assert(listed.includes("Exit code: 0"), `the command succeeded (${listed})`);
  assert(/^notes\.txt$/mu.test(listed), `the transcript shows notes.txt in the folder (${listed})`);

  const seen = (await modelRequests()).at(-1) ?? "";
  assert(
    seen.includes('source=\\"command output\\"') && seen.includes("notes.txt"),
    "the model got the listing back as untrusted command output",
  );

  const rows = auditRows();
  const allowed = rows.filter((row) => row.decision === "allow");
  assert(
    allowed.length === 1 && allowed[0]?.action === "run",
    `the audit table has one run allow row (${JSON.stringify(rows)})`,
  );
  assert(
    Schema.decodeUnknownSync(CommandDetail)(allowed[0]?.detail).command === makeNotes,
    `run · allow holds the command (${allowed[0]?.detail})`,
  );
  assert(
    rows.some((row) => row.decision === "succeeded" && row.action === "run"),
    "the run is recorded as succeeded",
  );

  const traceId = allowed[0]?.trace_id ?? "";
  assert(traceId !== "", "the allow row carries the turn's trace_id");

  let spans: Awaited<ReturnType<typeof traceSpans>> = [];

  await waitFor("the turn's Chat.turn and Gateway.act spans in Tempo", 60_000, async () => {
    spans = await traceSpans(grafanaUrl, traceId).catch(() => []);

    return ["Chat.turn", "Gateway.act"].every((name) => spans.some((span) => span.name === name));
  });

  const gatewayCall = spans.find((span) => span.name === "Gateway.act");
  assert(
    gatewayCall !== undefined && ancestry(spans, gatewayCall)[0] === "Chat.turn",
    "the Gateway.act span is inside Chat.turn",
  );
  assert(
    attribute(gatewayCall, "gateway.command_end") === "exited" &&
      attribute(gatewayCall, "gateway.exit_code") === "0",
    `the Gateway.act span records exit code 0 (${JSON.stringify(gatewayCall.attributes)})`,
  );

  await script([
    ModelStep.CallTools({ calls: [{ name: "run", params: { command: readDatabase } }] }),
    ModelStep.CallTools({ calls: [{ name: "run", params: { command: reachServer } }] }),
    ModelStep.Say({ words: ["Neither", " worked."] }),
  ]);

  await ask("Read the server's database, then open the server.", 1, "Neither worked.");
  await waitFor("both probe cards to be done", 10_000, () => doneCards("run") === 3);

  const [, database = "", server = ""] = runOutputs();
  assert(
    /Exit code: [1-9]/u.test(database) && database.includes("No such file or directory"),
    `the server's database is not on the computer (${database})`,
  );
  assert(
    /Exit code: [1-9]/u.test(server) && server.includes("inside the computer's own network"),
    `a command that honours its proxy settings cannot reach the server (${server})`,
  );

  assert(answers()[1] === "Neither worked.", "the Bot said what happened");
}
