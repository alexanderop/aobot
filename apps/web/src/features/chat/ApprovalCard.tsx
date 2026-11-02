import type { ApprovalAnswer, ConversationId } from "@aobot/domain";
import { Option } from "effect";
import { useEffect, useRef } from "react";
import { ApprovalCard as Card } from "./approval-card.ts";
import { useApproval } from "./use-approval.ts";

/** The answers a person can give, each with the key the card letters it by. */
const choices: ReadonlyArray<{ readonly key: string; readonly answer: ApprovalAnswer }> = [
  { key: "A", answer: "yes" },
  { key: "B", answer: "no" },
];

const answerLabels: Readonly<Record<ApprovalAnswer, string>> = { yes: "Yes", no: "No" };

/**
The question a Bot waits on before an action a rule asks about, as a card in the chat: the question the
server worded, then a lettered row per answer. The rows are disabled while an answer is on its way, and
why the server refused one shows below them. Once answered, it says which, for the rest of the turn.
*/
export function ApprovalCard(props: {
  readonly conversationId: ConversationId;
  readonly isRunning: boolean;
}) {
  const { card, choose } = useApproval(props.conversationId, props.isRunning);
  const shown = useRef<HTMLElement>(null);

  const showing = Option.match(card, {
    onNone: () => "",
    onSome: Card.$match({ Asking: ({ pending }) => pending.approval, Answered: () => "answered" }),
  });

  useEffect(() => {
    shown.current?.scrollIntoView({ block: "end" });
  }, [showing]);

  return Option.match(card, {
    onNone: () => null,
    onSome: Card.$match({
      Asking: ({ pending, sending, problem }) => (
        <section ref={shown} className="approval" aria-label="Approval">
          <p className="approval__question">{pending.question}</p>
          {choices.map(({ key, answer }) => (
            <button
              key={answer}
              type="button"
              className="approval__answer"
              onClick={() => choose(answer)}
              disabled={sending}
            >
              <span className="approval__key" aria-hidden="true">
                {key}
              </span>
              {answerLabels[answer]}
            </button>
          ))}
          {Option.match(problem, {
            onNone: () => null,
            onSome: (message) => (
              <p className="approval__problem" role="alert">
                {message}
              </p>
            ),
          })}
        </section>
      ),
      Answered: ({ question, answer }) => (
        <section ref={shown} className="approval" aria-label="Approval">
          <p className="approval__question">{question}</p>
          <p className="approval__answered">You answered {answerLabels[answer]}</p>
        </section>
      ),
    }),
  });
}
