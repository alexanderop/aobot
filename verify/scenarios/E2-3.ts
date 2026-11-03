import { spawnSync } from "node:child_process";
import { Schema } from "effect";
import { ModelStep, refTo } from "../../apps/server/src/features/agent/testing/model-script.ts";
import { assert, browser, evaluate, waitFor } from "../browser.ts";
import {
  answers,
  ask,
  auditRows,
  cardResult,
  databaseHolds,
  doneCards,
  modelRequests,
  script,
  send,
  serverLog,
  turnEnded,
} from "../chat.ts";
import { loginPassword } from "../login.ts";
import { computerContainer } from "../stack.ts";
import { attribute, gatewayActSpan, type TempoSpan, traceSpans } from "../tempo.ts";

const typed = "hunter2-secret";

const field = "the password for the login page";

const searchPage = "http://fixture:8080/search";

const loginPage = "http://fixture:8080/login";

const typedAnswer = "I typed it into the search box.";

const signedInAnswer = "I am signed in.";

const secretCard = '.tool-call[data-tool="request_secret"]';

const Detail = Schema.fromJsonString(
  Schema.Struct({
    text: Schema.optional(Schema.String),
    field: Schema.optional(Schema.String),
    chars: Schema.optional(Schema.Number),
    role: Schema.optional(Schema.String),
    name: Schema.optional(Schema.String),
  }),
);

/**
The spans of trace `traceId` once Tempo has the server's `Gateway.act` span of `tool` and the computer's
span of `computerAction`, which it exports on its own.
*/
async function spansOnce(
  grafanaUrl: string,
  traceId: string,
  tool: string,
  computerAction: string,
): Promise<ReadonlyArray<TempoSpan>> {
  let spans: ReadonlyArray<TempoSpan> = [];

  await waitFor(`the ${tool} spans of the server and the computer in Tempo`, 60_000, async () => {
    spans = await traceSpans(grafanaUrl, traceId).catch(() => []);

    return (
      gatewayActSpan(spans, tool) !== undefined &&
      spans.some((span) => attribute(span, "computer.action") === computerAction)
    );
  });

  return spans;
}

/**
E2-3: the Bot types `hunter2-secret` into a search box, and its audit row keeps `[14 chars]`. Then it
signs in to the fixture's `/login` with `request_secret`: the transcript shows a secret card naming the
field on `fixture`, the host the server read, the person types the password into it in the real browser, the Bot is signed in, and the page it reads back hides
the password field's value. Neither secret is in the server's SQLite files, a trace in Tempo, the server's
or the computer's log, or any audit row; the password is in no request the mock model received either.

Two things hold a secret by design and are not searched. The person's own message is stored as they wrote
it, so it asks for "the phrase from your notes" and the scripted model types `hunter2-secret`. And the
model's request history holds its own `type` call, `hunter2-secret` included, so only the password is
searched for there.
*/
export default async function scenario(baseUrl: string, grafanaUrl: string): Promise<void> {
  const searchBox = refTo("searchbox", "Search");

  await script([
    ModelStep.CallTools({ calls: [{ name: "navigate", params: { url: searchPage } }] }),
    ModelStep.CallTools({ calls: [{ name: "type", params: { ref: searchBox, text: typed } }] }),
    ModelStep.Say({ words: typedAnswer.split(/(?= )/u) }),
  ]);

  browser("open", baseUrl);
  browser("wait", "--load", "networkidle");

  await ask("Type the phrase from your notes into the search box.", 0, typedAnswer);
  await waitFor("the type card to be done", 10_000, () => doneCards("type") === 1);

  const typeRow = auditRows().find((row) => row.action === "type" && row.decision === "allow");
  assert(typeRow !== undefined, "the audit has a type · allow row");
  assert(
    typeRow.detail.includes(`"text":"[${typed.length} chars]"`),
    `type · allow keeps "text":"[14 chars]" (${typeRow.detail})`,
  );

  await script([
    ModelStep.CallTools({ calls: [{ name: "navigate", params: { url: loginPage } }] }),
    ModelStep.CallTools({
      calls: [{ name: "type", params: { ref: refTo("textbox", "Username"), text: "ada" } }],
    }),
    ModelStep.CallTools({
      calls: [{ name: "request_secret", params: { ref: refTo("textbox", "Password"), field } }],
    }),
    ModelStep.CallTools({
      calls: [{ name: "click", params: { ref: refTo("button", "Sign in") } }],
    }),
    ModelStep.Say({ words: signedInAnswer.split(/(?= )/u) }),
  ]);

  await turnEnded();
  send("Sign in to the login page as ada.");

  await waitFor(
    "the secret card to ask for the password",
    60_000,
    () => browser("get", "count", `${secretCard} input[type="password"]`) === "1",
  );
  assert(
    browser("get", "text", secretCard).includes(`Asks for ${field} on fixture`),
    "the secret card names the field the Bot asked for, on the host the server read",
  );

  browser("fill", `${secretCard} input[type="password"]`, loginPassword);
  browser("click", `${secretCard} button[type="submit"]`);

  await waitFor("the Bot to say it is signed in", 120_000, () => answers()[1] === signedInAnswer);
  await waitFor(
    "the request and click cards to be done",
    10_000,
    () => doneCards("request_secret") === 1 && doneCards("click") === 1,
  );

  assert(
    browser("get", "text", secretCard).includes(`Supplied ${field}`),
    "the secret card says the password was supplied",
  );
  assert(
    cardResult("request_secret").includes('textbox "Password"') &&
      cardResult("request_secret").includes('"[hidden]"'),
    `the page the Bot read after the secret hides the password field (${cardResult("request_secret")})`,
  );
  assert(cardResult("click").includes("Signed in as ada"), "the Bot is signed in");
  assert(
    !evaluate(Schema.String, "document.documentElement.outerHTML").includes(loginPassword),
    "the page the person typed into no longer holds the password",
  );

  const requests = await modelRequests();
  assert(requests.length > 0, "the mock model received the turn's requests");
  assert(
    requests.some((request) => request.includes('textbox \\"Password\\"')),
    "the model read the sign-in page back, so the search below looks where the password could be",
  );
  assert(
    requests.every((request) => !request.includes(loginPassword)),
    "no request the mock model received holds the password",
  );

  const rows = auditRows();
  const secretRows = rows.filter((row) => row.action.startsWith("secret."));
  assert(
    secretRows.map((row) => `${row.action} · ${row.decision}`).join(", ") ===
      "secret.requested · allow, secret.requested · succeeded, secret.supplied · allow, secret.supplied · succeeded",
    `the audit records the request and the supply (${JSON.stringify(secretRows)})`,
  );

  const requested = Schema.decodeUnknownSync(Detail)(secretRows[0]?.detail);
  assert(
    requested.field === field && requested.role === "textbox" && requested.name === "Password",
    `secret.requested names the field and the element (${secretRows[0]?.detail})`,
  );

  const suppliedRow = secretRows[2];
  assert(
    Schema.decodeUnknownSync(Detail)(suppliedRow?.detail).chars === loginPassword.length,
    `secret.supplied keeps the length only (${suppliedRow?.detail})`,
  );

  const everyRow = JSON.stringify(rows);
  assert(!everyRow.includes(typed), "no audit row holds what the Bot typed");
  assert(!everyRow.includes(loginPassword), "no audit row holds the password");

  assert(
    databaseHolds([field]).length === 1,
    "the search of the database files finds what the audit rows hold",
  );
  assert(
    databaseHolds([typed, loginPassword]).length === 0,
    "the server's database files hold neither secret, its stored messages included",
  );

  const typeTrace = typeRow.trace_id ?? "";
  const secretTrace = suppliedRow?.trace_id ?? "";
  assert(typeTrace !== "" && secretTrace !== "", "the rows carry their turns' trace ids");

  const traced = JSON.stringify([
    await spansOnce(grafanaUrl, typeTrace, "type", "type"),
    await spansOnce(grafanaUrl, secretTrace, "request_secret", "type_secret"),
  ]);

  assert(
    traced.includes('"Browser.typeSecret"'),
    "the traces hold the computer's spans of typing the secret, so the search below covers them",
  );
  assert(!traced.includes(typed), "no span in Tempo holds what the Bot typed");
  assert(!traced.includes(loginPassword), "no span in Tempo holds the password");

  const computerLog = spawnSync("docker", ["logs", computerContainer], { encoding: "utf8" });
  const logs = [serverLog(), computerLog.stdout, computerLog.stderr].join("\n");
  assert(logs.trim() !== "", "the server and the computer printed logs to search");
  assert(
    !logs.includes(typed) && !logs.includes(loginPassword),
    "neither the server's log nor the computer's holds either secret",
  );
}
