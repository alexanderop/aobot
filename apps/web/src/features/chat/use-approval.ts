import type { ApprovalAnswer, ConversationId, MessageId, PendingApproval } from "@aobot/domain";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";
import { type ApprovalPrompt, approvalPrompt } from "./approval-prompt.ts";
import { approvalAnswer, approvalPending } from "./approvals.ts";

/** What a conversation's approval card shows, and how the person answers it. */
export interface UseApproval {
  readonly prompt: Option.Option<ApprovalPrompt>;
  /** Sends `answer` to the question `pending`, the one the card asks. */
  readonly choose: (pending: PendingApproval, answer: ApprovalAnswer) => void;
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
      (shown: PendingApproval, answer: ApprovalAnswer) =>
        send({ conversation, turn, pending: shown, answer }),
      [conversation, turn, send],
    ),
  };
}
