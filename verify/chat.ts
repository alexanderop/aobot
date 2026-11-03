import { Schema } from "effect";
import type { ModelScript } from "../apps/server/src/features/agent/testing/model-script.ts";
import { assert, browser, evaluate, waitFor } from "./browser.ts";
import { composeOutput } from "./stack.ts";

/** The mock model's control routes, published on loopback by verify/compose.yml. */
const mockModel = "http://localhost:4110";

const AuditRows = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      decision: Schema.String,
      action: Schema.String,
      actor_id: Schema.String,
      trace_id: Schema.NullOr(Schema.String),
      detail: Schema.String,
    }),
  ),
);

const ModelRequests = Schema.Struct({ requests: Schema.Array(Schema.String) });

/** Replace what the mock model does for the next turn. */
export async function script(steps: ModelScript): Promise<void> {
  const response = await fetch(`${mockModel}/mock/script`, {
    method: "PUT",
    body: JSON.stringify(steps),
  });

  assert(response.ok, `the mock model took a ${steps.length}-step script (${response.status})`);
}

/** Every audit row, oldest first, read from the SQLite file on the server's volume. */
export function everyAuditRow() {
  const read = `const { DatabaseSync } = require("node:sqlite");
const rows = new DatabaseSync("/data/aobot.db")
  .prepare("SELECT decision, action, actor_id, trace_id, detail FROM audit_rows ORDER BY seq").all();
console.log(JSON.stringify(rows));`;

  return Schema.decodeUnknownSync(AuditRows)(
    composeOutput("exec", "-T", "server", "node", "-e", read),
  );
}

/**
The audit rows of what the scenario did, oldest first: every row but those of signing in, which
`vp run verify` did before the scenario began.
*/
export function auditRows() {
  return everyAuditRow().filter((row) => !row.action.startsWith("auth."));
}

const Held = Schema.fromJsonString(Schema.Array(Schema.String));

/**
Which of `texts` are anywhere in the bytes of the server's SQLite files on its volume: the database, and
its journal or write-ahead log when there is one, so a row since deleted or overwritten counts too.
*/
export function databaseHolds(texts: ReadonlyArray<string>): ReadonlyArray<string> {
  const read = `const { readdirSync, readFileSync } = require("node:fs");
const bytes = Buffer.concat(readdirSync("/data").filter((name) => name.startsWith("aobot.db"))
  .map((name) => readFileSync("/data/" + name)));
console.log(JSON.stringify(process.argv.slice(1).filter((text) => bytes.includes(Buffer.from(text)))));`;

  return Schema.decodeUnknownSync(Held)(
    composeOutput("exec", "-T", "server", "node", "-e", read, ...texts),
  );
}

/** What the server printed since it started. */
export function serverLog(): string {
  return composeOutput("logs", "server");
}

/** What the server sent the mock model since the last script. */
export async function modelRequests(): Promise<ReadonlyArray<string>> {
  const response = await fetch(`${mockModel}/mock/requests`);

  return Schema.decodeUnknownSync(ModelRequests)(await response.json()).requests;
}

/** The text of every answer on the page that has any, oldest first. */
export function answers(): ReadonlyArray<string> {
  return evaluate(
    Schema.Array(Schema.String),
    "[...document.querySelectorAll('.bubble--assistant .bubble__text')].map((node) => node.textContent)",
  ).filter((text) => text !== "");
}

function cards(tool: string, status: "done" | "failed"): number {
  return Number(
    browser("get", "count", `.tool-call[data-tool="${tool}"][data-status="${status}"]`),
  );
}

/** How many cards for `tool` the transcript draws as done. */
export function doneCards(tool: string): number {
  return cards(tool, "done");
}

/** How many cards for `tool` the transcript draws as failed. */
export function failedCards(tool: string): number {
  return cards(tool, "failed");
}

/** The result the first card for `tool` shows, or nothing before it has one. */
export function cardResult(tool: string): string {
  return evaluate(
    Schema.String,
    `document.querySelector('.tool-call[data-tool="${tool}"] .tool-call__result')?.textContent ?? ""`,
  );
}

/** Whether no turn runs in the open conversation, so its composer takes a message: it shows no Stop. */
export function idle(): boolean {
  return browser("get", "count", '[aria-label="Stop"]') === "0";
}

/**
Waits until the open conversation's turn has ended, so its composer takes a message again. The last word
of an answer can show a moment before its turn ends, and until then the composer holds Stop and Enter
sends nothing.
*/
export async function turnEnded(): Promise<void> {
  await waitFor("the turn to end", 30_000, idle);
}

/** The conversation the page has open, as its URL names it. */
export function openConversation(): string {
  return new URL(browser("get", "url")).searchParams.get("c") ?? "";
}

/** Send `text` from the composer of the conversation with `bot`, without waiting for the answer. */
export function send(text: string, bot = "Assistant"): void {
  browser("find", "placeholder", `Message ${bot}`, "fill", text);
  browser("press", "Enter");
}

/**
Send `text` from the composer once the last turn ended, and wait until answer number `index + 1` reads
`answer`.
*/
export async function ask(
  text: string,
  index: number,
  answer: string,
  bot = "Assistant",
): Promise<void> {
  await turnEnded();

  send(text, bot);

  await waitFor(`answer ${index + 1}`, 120_000, () => answers()[index] === answer);
}
