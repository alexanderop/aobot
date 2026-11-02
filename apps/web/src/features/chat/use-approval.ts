import type { ApprovalAnswer, ConversationId } from "@aobot/domain";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { ApprovalCard, approvalCard } from "./approval-card.ts";
import { approvalAnswer, approvalPending } from "./approvals.ts";

/** The approval card of a conversation, and how the person answers it. */
export interface UseApproval {
  readonly card: Option.Option<ApprovalCard>;
  /** Sends `answer` to the question the card asks, when it asks one. */
  readonly choose: (answer: ApprovalAnswer) => void;
}

/**
The question `conversation`'s Bot waits on while its turn is `running`, shaped like the other chat hooks:
values and functions.
*/
export function useApproval(conversation: ConversationId, running: boolean): UseApproval {
  const pending = Option.flatten(AsyncResult.value(useAtomValue(approvalPending(conversation))));
  const [last, send] = useAtom(approvalAnswer(conversation));
  const card = approvalCard(pending, last, running);

  const asking = Option.flatMap(card, (shown) =>
    ApprovalCard.$is("Asking")(shown) ? Option.some(shown.pending) : Option.none(),
  );

  return {
    card,
    choose: (answer) =>
      Option.match(asking, {
        onNone: () => undefined,
        onSome: (shown) => send({ conversation, pending: shown, answer }),
      }),
  };
}
