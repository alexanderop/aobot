import {
  type AuditAction,
  FileAction,
  PageAction,
  RefTarget,
  RunCommand,
  type ToolName,
} from "@aobot/domain";
import { Schema } from "effect";

/**
A Bot's `request_secret` once its ref resolved: the element the secret goes into, and the field as the Bot
named it for its person. The computer hears of it only once the person answered, as `type_secret`.
*/
export const SecretRequest = Schema.Struct({
  action: Schema.Literal("request_secret"),
  target: RefTarget,
  field: Schema.String,
});

/** A decoded {@link SecretRequest}. */
export type SecretRequest = typeof SecretRequest.Type;

/** A tool call the computer is sent as it is, once its ref resolved or its path was read. */
export const DirectAction = Schema.Union([
  PageAction.cases.navigate,
  PageAction.cases.snapshot,
  PageAction.cases.click,
  PageAction.cases.type,
  PageAction.cases.press,
  RunCommand,
  FileAction,
]).pipe(Schema.toTaggedUnion("action"));

/** A decoded {@link DirectAction}. */
export type DirectAction = typeof DirectAction.Type;

/**
A Bot's tool call once the gateway resolved its ref or read its path: what the rules judge and its audit
row describes, named by the tool the Bot called, so a rule's `tool.name` is that tool.
*/
export const ToolAction = Schema.Union([...DirectAction.members, SecretRequest]).pipe(
  Schema.toTaggedUnion("action"),
);

/** A decoded {@link ToolAction}. */
export type ToolAction = typeof ToolAction.Type;

/**
The action the audit rows of `tool` name: the tool itself, but for `request_secret` what happened,
`secret.requested`, which the person's answer follows with `secret.supplied`.
*/
export function auditAction(tool: ToolName): AuditAction {
  return tool === "request_secret" ? "secret.requested" : tool;
}
