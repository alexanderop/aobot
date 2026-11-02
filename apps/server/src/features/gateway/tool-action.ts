import { FileAction, PageAction, RunCommand } from "@aobot/domain";
import { Schema } from "effect";

/**
A Bot's tool call once the gateway resolved its ref or read its path: what the rules judge and its audit
row describes, named by the tool the Bot called, so a rule's `tool.name` is that tool. The computer is
sent it as it is.
*/
export const ToolAction = Schema.Union([
  PageAction.cases.navigate,
  PageAction.cases.snapshot,
  PageAction.cases.click,
  PageAction.cases.type,
  PageAction.cases.press,
  RunCommand,
  FileAction,
]).pipe(Schema.toTaggedUnion("action"));

/** A decoded {@link ToolAction}. */
export type ToolAction = typeof ToolAction.Type;
