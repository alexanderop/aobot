import { useState } from "react";
import type { KeyboardEvent } from "react";

/** The message bar. Enter sends, Shift+Enter adds a line, and a stop button replaces send while a run is going. */
export function Composer(props: {
  readonly botName: string;
  readonly disabled: boolean;
  readonly isRunning: boolean;
  readonly onSend: (text: string) => void;
  readonly onStop: () => void;
}) {
  const [draft, setDraft] = useState("");

  const submit = () => {
    if (props.disabled || props.isRunning || draft.trim() === "") return;
    props.onSend(draft);
    setDraft("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        className="composer__input"
        aria-label={`Message ${props.botName}`}
        placeholder={`Message ${props.botName}`}
        rows={1}
        value={draft}
        disabled={props.disabled}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {props.isRunning ? (
        <button
          type="button"
          className="composer__button composer__button--stop"
          aria-label="Stop"
          onClick={props.onStop}
        >
          <span className="composer__stop-icon" />
        </button>
      ) : (
        <button
          type="submit"
          className="composer__button"
          aria-label="Send"
          disabled={props.disabled || draft.trim() === ""}
        >
          <span className="composer__send-icon" />
        </button>
      )}
    </form>
  );
}
