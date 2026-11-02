import { answerLabels, ApprovalAnswer, type ConversationId, type MessageId } from "@aobot/domain";
import { Option } from "effect";
import { useEffect, useRef } from "react";
import { ApprovalPrompt } from "./approval-prompt.ts";
import { useApproval } from "./use-approval.ts";

/**
The question a Bot waits on before an action a rule asks about, as a card in the chat: the question the
server worded, then a lettered row per answer. The rows are disabled while an answer is on its way, and
why the server refused one shows below them. Once answered, it says which, for the rest of the turn.
*/
export function ApprovalCard(props: {
  readonly conversationId: ConversationId;
  readonly turn: Option.Option<MessageId>;
}) {
  const { prompt, choose } = useApproval(props.conversationId, props.turn);
  const shown = useRef<HTMLElement>(null);

  const showing = Option.match(prompt, {
    onNone: () => "",
    onSome: ApprovalPrompt.$match({
      Asking: ({ pending }) => pending.approval,
      Answered: () => "answered",
    }),
  });

  useEffect(() => {
    shown.current?.scrollIntoView({ block: "end" });
  }, [showing]);

  return Option.match(prompt, {
    onNone: () => null,
    onSome: (current) => (
      <section ref={shown} className="approval" aria-label="Approval">
        <p className="approval__question">
          {ApprovalPrompt.$match(current, {
            Asking: ({ pending }) => pending.question,
            Answered: ({ question }) => question,
          })}
        </p>
        {ApprovalPrompt.$match(current, {
          Asking: ({ pending, sending, problem }) => (
            <>
              {ApprovalAnswer.literals.map((answer) => (
                <button
                  key={answer}
                  type="button"
                  className="approval__answer"
                  onClick={() => choose(pending, answer)}
                  disabled={sending}
                >
                  <span className="approval__key" aria-hidden="true">
                    {answerLabels[answer].key}
                  </span>
                  {answerLabels[answer].label}
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
            </>
          ),
          Answered: ({ answer }) => (
            <p className="approval__answered">You answered {answerLabels[answer].label}</p>
          ),
        })}
      </section>
    ),
  });
}
