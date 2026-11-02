import type { BotId, PendingSecret } from "@aobot/domain";
import { Option, Schema } from "effect";
import { type FormEvent, useRef } from "react";
import { ToolCallStatus } from "./conversation-state.ts";
import type { ToolCall } from "./conversation-state.ts";
import { SecretEntry } from "./secret-entry.ts";
import { useSecretRequest } from "./use-secret-request.ts";

const decodeSecretArgs = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ ref: Schema.String, field: Schema.String })),
);

/** What the call's result says once it has one: the page after the secret, or why not. */
function CallResult({ status }: { readonly status: ToolCallStatus }) {
  const shown = (summary: string, text: string) => (
    <details className="tool-call__details">
      <summary className="tool-call__summary">{summary}</summary>
      <pre className="tool-call__result">{text}</pre>
    </details>
  );

  return ToolCallStatus.$match(status, {
    Running: () => null,
    Done: ({ result }) => shown("The page after", result),
    Failed: ({ result }) => shown("Why", result),
    Unfinished: () => null,
  });
}

/**
What the person is asked for: the field as the Bot named it, on the host of its page as the server read
it, so a Bot cannot pass one site's password field off as another's.
*/
function asked({ field, host }: PendingSecret): string {
  return host === "" ? field : `${field} on ${host}`;
}

/**
A Bot asking its person for a secret: the field it named on the host the server read, a password input
and Supply or Decline. What the person types stays in the input until they supply it, goes straight to
the server, and the input is emptied at once; the transcript never holds it. Once answered, the card
says so, never with the value.
*/
export function SecretRequestCall({ call, bot }: { readonly call: ToolCall; readonly bot: BotId }) {
  const { entry, supply, decline } = useSecretRequest(call, bot);
  const input = useRef<HTMLInputElement>(null);

  const field = Option.match(decodeSecretArgs(call.args), {
    onNone: () => "a secret",
    onSome: (args) => args.field,
  });

  const submit = (request: PendingSecret) => (event: FormEvent) => {
    event.preventDefault();
    const secret = input.current?.value ?? "";

    if (input.current !== null) input.current.value = "";
    supply(request.request, secret);
  };

  return SecretEntry.$match(entry, {
    Opening: () => <p className="tool-call__title">Asks for {field}</p>,
    Asking: ({ request, sending, problem }) => (
      <form className="secret-entry" onSubmit={submit(request)}>
        <p className="tool-call__title">Asks for {asked(request)}</p>
        <input
          ref={input}
          className="secret-entry__input"
          type="password"
          aria-label={asked(request)}
          autoComplete="off"
          required
          disabled={sending}
        />
        <div className="secret-entry__actions">
          <button
            type="submit"
            className="secret-entry__button secret-entry__button--accent"
            disabled={sending}
          >
            Supply
          </button>
          <button
            type="button"
            className="secret-entry__button"
            onClick={() => decline(request.request)}
            disabled={sending}
          >
            Decline
          </button>
        </div>
        <p className="secret-entry__note">
          It goes straight to the Bot's computer. The Bot never sees it.
        </p>
        {Option.match(problem, {
          onNone: () => null,
          onSome: (message) => (
            <p className="secret-entry__problem" role="alert">
              {message}
            </p>
          ),
        })}
      </form>
    ),
    Answered: ({ answer }) => (
      <>
        <p className="tool-call__title">
          {answer === "Supplied" ? `Supplied ${field}` : `Declined to give ${field}`}
        </p>
        <CallResult status={call.status} />
      </>
    ),
    NotTyped: () => (
      <>
        <p className="tool-call__title">Supplied {field}, not typed</p>
        <CallResult status={call.status} />
      </>
    ),
    Ended: () => (
      <>
        <p className="tool-call__title">Did not get {field}</p>
        <CallResult status={call.status} />
      </>
    ),
  });
}
