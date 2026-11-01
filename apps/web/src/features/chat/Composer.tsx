import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Attachment, hasReady, stillUploading } from "./attachment-state.ts";

/** One picked file in the composer: its name, and while it uploads or once it failed, how it went. */
function AttachmentChip(props: {
  readonly attachment: Attachment;
  readonly onDismiss: (id: string) => void;
}) {
  const { id, name } = props.attachment;

  return (
    <li className="attachment" data-status={props.attachment._tag.toLowerCase()}>
      <span className="attachment__name">{name}</span>
      {Attachment.$match(props.attachment, {
        Uploading: () => <span className="attachment__note">Uploading…</span>,
        Ready: () => null,
        Failed: ({ message }) => (
          <span className="attachment__note" role="alert">
            {message}
          </span>
        ),
      })}
      <button
        type="button"
        className="attachment__dismiss"
        aria-label={`Remove ${name}`}
        onClick={() => props.onDismiss(id)}
      >
        ×
      </button>
    </li>
  );
}

/**
The message bar. Enter sends, Shift+Enter adds a line, and a stop button replaces send while a run is
going. `＋` uploads files into the Bot's workspace at once, and the message waits while one is still on
its way. `onSend` says whether the message went, so a draft it turned away is kept.
*/
export function Composer(props: {
  readonly botName: string;
  readonly disabled: boolean;
  readonly isRunning: boolean;
  readonly attachments: ReadonlyArray<Attachment>;
  readonly onAttach: (files: ReadonlyArray<File>) => void;
  readonly onDismiss: (id: string) => void;
  readonly onSend: (draft: string) => boolean;
  readonly onStop: () => void;
}) {
  const [draft, setDraft] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const waiting = stillUploading(props.attachments);
  const empty = draft.trim() === "" && !hasReady(props.attachments);

  const submit = () => {
    if (props.disabled || props.isRunning || waiting || empty) return;

    if (props.onSend(draft)) setDraft("");
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
      {props.attachments.length === 0 ? null : (
        <ul className="composer__attachments" aria-label="Files for your Bot's workspace">
          {props.attachments.map((attachment) => (
            <AttachmentChip
              key={attachment.id}
              attachment={attachment}
              onDismiss={props.onDismiss}
            />
          ))}
        </ul>
      )}
      <div className="composer__bar">
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          aria-label="Files to attach"
          onChange={(event) => {
            props.onAttach([...(event.target.files ?? [])]);
            // Cleared, so picking the same file again uploads it again.
            event.target.value = "";
          }}
        />
        <button
          type="button"
          className="composer__attach"
          aria-label="Attach a file"
          disabled={props.disabled}
          onClick={() => picker.current?.click()}
        >
          <span className="composer__attach-icon" aria-hidden="true" />
        </button>
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
            disabled={props.disabled || waiting || empty}
          >
            <span className="composer__send-icon" />
          </button>
        )}
      </div>
    </form>
  );
}
