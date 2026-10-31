import "./planned.css";

/** One way to answer: the key the person can press and what it means. */
export interface Answer {
  readonly key: string;
  readonly label: string;
}

/** Planned in E2-5: a Bot asks before a risky action. The question and its answers sit in the chat, not in a modal. */
export function ApprovalCard(props: {
  readonly question: string;
  readonly answers: readonly Answer[];
}) {
  return (
    <div className="approval" role="group" aria-label={props.question}>
      <p className="approval__question">{props.question}</p>
      <ul className="approval__answers">
        {props.answers.map((answer) => (
          <li key={answer.key}>
            <button type="button" className="approval__answer">
              <kbd className="approval__key">{answer.key}</kbd>
              {answer.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
