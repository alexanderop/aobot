import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { ToolName } from "./bot.ts";
import { ConversationId } from "./ids.ts";

/** How a person answers an action a rule asks them about. */
export const ApprovalAnswer = Schema.Literals(["yes", "no"]);

/** A decoded {@link ApprovalAnswer}. */
export type ApprovalAnswer = typeof ApprovalAnswer.Type;

/**
How each answer reads, on the approval card and the audit page, and the key the card letters it by. The
card shows them in {@link ApprovalAnswer}'s order.
*/
export const answerLabels: Readonly<
  Record<ApprovalAnswer, { readonly label: string; readonly key: string }>
> = {
  yes: { label: "Yes", key: "A" },
  no: { label: "No", key: "B" },
};

/**
Who answered a question a rule put to the person, as its `approval.answered` row says: the person, or no
on their behalf once the time limit passed, their turn was stopped, or the server stopped while it waited.
*/
export const ApprovalAnsweredBy = Schema.Literals([
  "person",
  "time limit",
  "the turn was stopped",
  "the server stopped",
]);

/** A decoded {@link ApprovalAnsweredBy}. */
export type ApprovalAnsweredBy = typeof ApprovalAnsweredBy.Type;

/** The id the server gives one question about one action, so an answer reaches only that question. */
export const ApprovalId = Schema.String.pipe(Schema.brand("ApprovalId"));

/** A decoded {@link ApprovalId}. */
export type ApprovalId = typeof ApprovalId.Type;

/**
An action a rule asks the person about, as they are shown it: the tool, and the question, which the server
words from the action as it resolved it, showing the command, address or text as the Bot wrote it. Only
the person's own page sees it, never an audit row, a log, a span or the conversation.
*/
export const PendingApproval = Schema.Struct({
  approval: ApprovalId,
  tool: ToolName,
  question: Schema.String,
});

/** A decoded {@link PendingApproval}. */
export type PendingApproval = typeof PendingApproval.Type;

/** The conversation waits on no such question: none was asked, or it was answered, timed out or stopped. */
export class NoApprovalWaiting extends Schema.TaggedError<NoApprovalWaiting>()(
  "NoApprovalWaiting",
  { message: Schema.String },
) {}

/**
A person answering an action a rule asked them about. `Approval.pending` streams the question the
conversation waits on, the current one first, and never fails. `Approval.answer` hands the answer to that
question, named by its id, and returns; what the action then did, the Bot's tool call says.
*/
export class ApprovalRpcs extends RpcGroup.make(
  Rpc.make("Approval.pending", {
    payload: { conversation: ConversationId },
    success: Schema.OptionFromNullOr(PendingApproval),
    stream: true,
  }),
  Rpc.make("Approval.answer", {
    payload: { conversation: ConversationId, approval: ApprovalId, answer: ApprovalAnswer },
    error: NoApprovalWaiting,
  }),
) {}
