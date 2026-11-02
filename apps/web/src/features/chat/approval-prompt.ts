import type { ApprovalAnswer, ApprovalId, PendingApproval } from "@aobot/domain";
import { Data, Option } from "effect";
import { AsyncResult } from "effect/reactivity";

/** What the server said to the person's answer: taken, or refused and why. */
export type ApprovalReply = Data.TaggedEnum<{
  Taken: {
    readonly approval: ApprovalId;
    readonly question: string;
    readonly answer: ApprovalAnswer;
  };
  Refused: { readonly approval: ApprovalId; readonly message: string };
}>;

/** Constructors and matchers for {@link ApprovalReply}. */
export const ApprovalReply = Data.taggedEnum<ApprovalReply>();

/**
What the approval card shows. `Asking` while the Bot waits for the person, with the question as the server
shows it, their answer on its way or why the last one was refused. `Answered` once the server took it, for
the rest of the turn.
*/
export type ApprovalPrompt = Data.TaggedEnum<{
  Asking: {
    readonly pending: PendingApproval;
    readonly sending: boolean;
    readonly problem: Option.Option<string>;
  };
  Answered: { readonly question: string; readonly answer: ApprovalAnswer };
}>;

/** Constructors and matchers for {@link ApprovalPrompt}. */
export const ApprovalPrompt = Data.taggedEnum<ApprovalPrompt>();

/**
The card of a conversation whose Bot waits on `pending`, whose person's last answer is `last`, while its
turn is `running` or not. None while nothing is asked and nothing was answered in this turn.
*/
export function approvalPrompt(
  pending: Option.Option<PendingApproval>,
  last: AsyncResult.AsyncResult<ApprovalReply>,
  running: boolean,
): Option.Option<ApprovalPrompt> {
  const reply = last.waiting ? Option.none() : AsyncResult.value(last);
  const taken = Option.filter(reply, ApprovalReply.$is("Taken"));
  const refused = Option.filter(reply, ApprovalReply.$is("Refused"));

  const answered = Option.map(taken, ({ question, answer }) =>
    ApprovalPrompt.Answered({ question, answer }),
  );

  return Option.match(pending, {
    onNone: () => (running ? answered : Option.none()),
    onSome: (shown) =>
      Option.exists(taken, ({ approval }) => approval === shown.approval)
        ? answered
        : Option.some(
            ApprovalPrompt.Asking({
              pending: shown,
              sending: last.waiting,
              problem: Option.map(
                Option.filter(refused, ({ approval }) => approval === shown.approval),
                ({ message }) => message,
              ),
            }),
          ),
  });
}
