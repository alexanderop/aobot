import { ApprovalRpcs } from "@aobot/domain";
import { Effect } from "effect";
import { ApprovalRequests } from "./approvals.ts";

/** The `Approval.*` handlers: a person answering an action a rule asked them about, straight to the gateway. */
export const approvalHandlers = ApprovalRpcs.toLayer(
  Effect.gen(function* () {
    const approvals = yield* ApprovalRequests;

    return ApprovalRpcs.of({
      "Approval.pending": ({ conversation }) => approvals.pending(conversation),
      "Approval.answer": ({ conversation, approval, answer }) =>
        approvals.answer(conversation, approval, answer),
    });
  }),
);
