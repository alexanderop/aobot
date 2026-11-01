import { Schema } from "effect";
import type { ModelScript } from "../apps/server/src/features/agent/testing/model-script.ts";
import { assert, browser, waitFor } from "./browser.ts";
import { composeOutput } from "./stack.ts";

/** The mock model's control routes, published on loopback by verify/compose.yml. */
const mockModel = "http://localhost:4110";

const AuditRows = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      decision: Schema.String,
      action: Schema.String,
      trace_id: Schema.NullOr(Schema.String),
      detail: Schema.String,
    }),
  ),
);

const ModelRequests = Schema.Struct({ requests: Schema.Array(Schema.String) });

const AnswerTexts = Schema.fromJsonString(Schema.Array(Schema.String));

/** Replace what the mock model does for the next turn. */
export async function script(steps: ModelScript): Promise<void> {
  const response = await fetch(`${mockModel}/mock/script`, {
    method: "PUT",
    body: JSON.stringify(steps),
  });

  assert(response.ok, `the mock model took a ${steps.length}-step script (${response.status})`);
}

/** Every audit row, oldest first, read from the SQLite file on the server's volume. */
export function auditRows() {
  const read = `const { DatabaseSync } = require("node:sqlite");
const rows = new DatabaseSync("/data/aobot.db")
  .prepare("SELECT decision, action, trace_id, detail FROM audit_rows ORDER BY seq").all();
console.log(JSON.stringify(rows));`;

  return Schema.decodeUnknownSync(AuditRows)(
    composeOutput("exec", "-T", "server", "node", "-e", read),
  );
}

/** What the server sent the mock model since the last script. */
export async function modelRequests(): Promise<ReadonlyArray<string>> {
  const response = await fetch(`${mockModel}/mock/requests`);

  return Schema.decodeUnknownSync(ModelRequests)(await response.json()).requests;
}

/** The text of every answer on the page that has any, oldest first. */
export function answers(): ReadonlyArray<string> {
  return Schema.decodeUnknownSync(AnswerTexts)(
    browser(
      "eval",
      "[...document.querySelectorAll('.bubble--assistant .bubble__text')].map((node) => node.textContent)",
    ),
  ).filter((text) => text !== "");
}

/** How many cards for `tool` the transcript draws as done. */
export function doneCards(tool: string): number {
  return Number(browser("get", "count", `.tool-call[data-tool="${tool}"][data-status="done"]`));
}

/** Send `text` from the composer and wait until answer number `index + 1` reads `answer`. */
export async function ask(text: string, index: number, answer: string): Promise<void> {
  browser("find", "placeholder", "Message Assistant", "fill", text);
  browser("press", "Enter");

  await waitFor(`answer ${index + 1}`, 120_000, () => answers()[index] === answer);
}
