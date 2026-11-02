import { DateTime, Schema } from "effect";

/**
What an audit row says of its action: the gateway's decision, `allow` or `deny`, or `ask` when it asked the
person first and `answered` once they answered or the time ran out; or what became of an allowed action,
`succeeded`, `failed` or `unknown`.
*/
export const AuditDecision = Schema.Literals([
  "allow",
  "deny",
  "ask",
  "answered",
  "succeeded",
  "failed",
  "unknown",
]);

/** A decoded {@link AuditDecision}. */
export type AuditDecision = typeof AuditDecision.Type;

/** Whether `raw` is an {@link AuditDecision}. */
export const isDecision = Schema.is(AuditDecision);

/** Who an action was done for: a person who was watching, or the deployment itself. */
export const InitiatorKind = Schema.Literals(["person", "deployment"]);

/** A decoded {@link InitiatorKind}. */
export type InitiatorKind = typeof InitiatorKind.Type;

/**
The client methods of ACP a CLI can call on the server. Every one is refused with a `deny` row named by
the method, since a Bot acts only through the gateway's tools.
*/
export const AcpClientMethod = Schema.Literals([
  "session/request_permission",
  "fs/read_text_file",
  "fs/write_text_file",
  "terminal/create",
  "terminal/output",
  "terminal/wait_for_exit",
  "terminal/kill",
  "terminal/release",
]);

/** A decoded {@link AcpClientMethod}. */
export type AcpClientMethod = typeof AcpClientMethod.Type;

/**
Every action an audit row can name: a Bot's tool, `request_secret` as `secret.requested` and the person's
answer as `secret.supplied`, the person's answer to an action a rule asked them about, a person taking or
handing back the computer, a person's file going in or out, and a CLI's call outside the gateway.
*/
export const AuditAction = Schema.Literals([
  "navigate",
  "snapshot",
  "click",
  "type",
  "press",
  "run",
  "read_file",
  "write_file",
  "list_files",
  "secret.requested",
  "secret.supplied",
  "approval.answered",
  "control_taken",
  "control_released",
  "file.uploaded",
  "file.downloaded",
  ...AcpClientMethod.literals,
]);

/** A decoded {@link AuditAction}. */
export type AuditAction = typeof AuditAction.Type;

/** How the audit page names each decision. */
const decisionLabels: Readonly<Record<AuditDecision, string>> = {
  allow: "Allowed",
  deny: "Refused",
  ask: "Asked the person",
  answered: "Answered",
  succeeded: "Succeeded",
  failed: "Failed",
  unknown: "Outcome unknown",
};

/** How the audit page names each action. */
const actionLabels: Readonly<Record<AuditAction, string>> = {
  navigate: "Open a page",
  snapshot: "Read the page",
  click: "Click",
  type: "Type",
  press: "Press a key",
  run: "Run a command",
  read_file: "Read a file",
  write_file: "Write a file",
  list_files: "List files",
  "secret.requested": "Ask for a secret",
  "secret.supplied": "Type a person's secret",
  "approval.answered": "Answer an approval",
  control_taken: "Take control",
  control_released: "Hand back control",
  "file.uploaded": "Upload a file",
  "file.downloaded": "Download a file",
  "session/request_permission": "CLI asks for permission",
  "fs/read_text_file": "CLI reads a file",
  "fs/write_text_file": "CLI writes a file",
  "terminal/create": "CLI opens a terminal",
  "terminal/output": "CLI reads a terminal",
  "terminal/wait_for_exit": "CLI waits for a terminal",
  "terminal/kill": "CLI stops a terminal",
  "terminal/release": "CLI closes a terminal",
};

/** What a decision or an action no table names reads as. Never "Allowed". */
export const unknownLabel = "Unknown";

const isAction = Schema.is(AuditAction);

/** How the audit page names the decision `raw`, or {@link unknownLabel} for one it does not know. */
export function decisionLabel(raw: string): string {
  return isDecision(raw) ? decisionLabels[raw] : unknownLabel;
}

/** How the audit page names the action `raw`, or {@link unknownLabel} for one it does not know. */
export function actionLabel(raw: string): string {
  return isAction(raw) ? actionLabels[raw] : unknownLabel;
}

/**
One audit row as the audit page reads it. `decision` and `action` stay as stored, so a row a newer
server wrote still reads, as Unknown. `createdAt` is the stored instant, verbatim. `bot` is the Bot the
action was for: an outcome row's is that of the `allow` row it follows. `traceUrl` opens the row's trace
in Grafana, when the server knows where Grafana is.
*/
export const AuditRow = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
  initiatorKind: InitiatorKind,
  person: Schema.String,
  bot: Schema.OptionFromOptionalKey(Schema.String),
  decision: Schema.String,
  action: Schema.String,
  detail: Schema.JsonObject,
  traceId: Schema.OptionFromOptionalKey(Schema.String),
  traceUrl: Schema.OptionFromOptionalKey(Schema.String),
});

/** A decoded {@link AuditRow}. */
export type AuditRow = typeof AuditRow.Type;

/** The most rows one page holds, and how many it holds when the query does not say. */
export const auditPageLimit = { max: 200, default: 50 } as const;

/**
An ISO instant in the years 0000 to 9999. `created_at` is stored as text with a four-digit year, so only
these compare with it in order.
*/
const FourDigitYearInstant = Schema.DateTimeUtcFromString.check(
  Schema.makeFilter((instant) => {
    const year = DateTime.getPartUtc(instant, "year");

    return (year >= 0 && year <= 9999) || "a year from 0000 to 9999";
  }),
);

/**
What `GET /audit/rows` takes as its query: rows for one Bot, one person or one decision, written at or
after `from` and before `to` (ISO instants), the page after `cursor`, at most `limit` rows. Each is
optional. `cursor` is opaque: the `next` of the page before.
*/
export const AuditQuery = Schema.Struct({
  bot: Schema.OptionFromOptionalKey(Schema.String),
  person: Schema.OptionFromOptionalKey(Schema.String),
  decision: Schema.OptionFromOptionalKey(AuditDecision),
  from: Schema.OptionFromOptionalKey(FourDigitYearInstant),
  to: Schema.OptionFromOptionalKey(FourDigitYearInstant),
  cursor: Schema.OptionFromOptionalKey(Schema.String),
  limit: Schema.OptionFromOptionalKey(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 1, maximum: auditPageLimit.max }),
    ),
  ),
});

/** A decoded {@link AuditQuery}. */
export type AuditQuery = typeof AuditQuery.Type;

/** What the audit page shows rows for: a Bot, a person, a decision and a time range, each optional. */
export type AuditFilters = Omit<AuditQuery, "cursor" | "limit">;

/** One page of audit rows, newest first, and the cursor of the page after it when there is one. */
export const AuditRowsPage = Schema.Struct({
  rows: Schema.Array(AuditRow),
  next: Schema.OptionFromOptionalKey(Schema.String),
});

/** A decoded {@link AuditRowsPage}. */
export type AuditRowsPage = typeof AuditRowsPage.Type;
