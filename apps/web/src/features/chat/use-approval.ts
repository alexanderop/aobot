import type { ApprovalAnswer, ConversationId, MessageId } from "@aobot/domain";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";
import { type ApprovalPrompt, approvalPrompt, type AskedQuestion } from "./approval-prompt.ts";
import { approvalAnswer, approvalPending } from "./approvals.ts";

/** What a conversation's approval card shows, and how the person answers it. */
export interface UseApproval {
  readonly prompt: Option.Option<ApprovalPrompt>;
  /** Sends `answer` to the question `asked`, the one the card asks. */
  readonly choose: (asked: AskedQuestion, answer: ApprovalAnswer) => void;
}

/**
The question `conversation`'s Bot waits on while the turn `turn` runs, shaped like the other chat hooks:
values and functions.
*/
export function useApproval(
  conversation: ConversationId,
  turn: Option.Option<MessageId>,
): UseApproval {
  const pending = Option.flatten(AsyncResult.value(useAtomValue(approvalPending(conversation))));
  const [last, send] = useAtom(approvalAnswer(conversation));

  return {
    prompt: approvalPrompt(pending, last, turn),
    choose: useCallback(
      (asked: AskedQuestion, answer: ApprovalAnswer) => send({ conversation, turn, asked, answer }),
      [conversation, turn, send],
    ),
  };
}
