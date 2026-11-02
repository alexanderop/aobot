import type { ApprovalAnswer, ApprovalId, MessageId, PendingApproval } from "@aobot/domain";
import { Data, Option } from "effect";
import { AsyncResult } from "effect/reactivity";

/** What the server said to the person's answer, given in the turn `turn`: taken, or refused and why. */
export type ApprovalReply = Data.TaggedEnum<{
  Taken: {
    readonly approval: ApprovalId;
    readonly turn: Option.Option<MessageId>;
    readonly question: string;
    readonly answer: ApprovalAnswer;
  };
  Refused: { readonly approval: ApprovalId; readonly message: string };
}>;

/** Constructors and matchers for {@link ApprovalReply}. */
export const ApprovalReply = Data.taggedEnum<ApprovalReply>();

/** The question a card asks, as the server worded it, and the server's id for it. */
export type AskedQuestion = Pick<PendingApproval, "approval" | "question">;

/**
What the approval card shows: the question, as the server worded it. `Asking` while the Bot waits for the
person, with their answer on its way or why the last one was refused. `Answered` once the server took it,
for the rest of the turn.
*/
export type ApprovalPrompt = Data.TaggedEnum<{
  Asking: {
    readonly approval: ApprovalId;
    readonly question: string;
    readonly sending: boolean;
    readonly problem: Option.Option<string>;
  };
  Answered: {
    readonly approval: ApprovalId;
    readonly question: string;
    readonly answer: ApprovalAnswer;
  };
}>;

/** Constructors and matchers for {@link ApprovalPrompt}. */
export const ApprovalPrompt = Data.taggedEnum<ApprovalPrompt>();

/**
The card of a conversation whose Bot waits on `pending`, whose person's last answer is `last`, while the
turn `turn` runs, none while none does. None while nothing is asked and nothing was answered in this turn,
so an answer from an earlier turn never shows in a later one.
*/
export function approvalPrompt(
  pending: Option.Option<PendingApproval>,
  last: AsyncResult.AsyncResult<ApprovalReply>,
  turn: Option.Option<MessageId>,
): Option.Option<ApprovalPrompt> {
  const reply = last.waiting ? Option.none() : AsyncResult.value(last);
  const taken = Option.filter(reply, ApprovalReply.$is("Taken"));
  const refused = Option.filter(reply, ApprovalReply.$is("Refused"));

  const answered = Option.map(taken, ({ approval, question, answer }) =>
    ApprovalPrompt.Answered({ approval, question, answer }),
  );

  return Option.match(pending, {
    onNone: () =>
      Option.exists(taken, (reply) =>
        Option.exists(turn, (now) => Option.contains(reply.turn, now)),
      )
        ? answered
        : Option.none(),
    onSome: (shown) =>
      Option.exists(taken, ({ approval }) => approval === shown.approval)
        ? answered
        : Option.some(
            ApprovalPrompt.Asking({
              approval: shown.approval,
              question: shown.question,
              sending: last.waiting,
              problem: Option.map(
                Option.filter(refused, ({ approval }) => approval === shown.approval),
                ({ message }) => message,
              ),
            }),
          ),
  });
}
