import type { PendingSecret, SecretAnswer, SecretRpcs } from "@aobot/domain";
import { Data, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import type { Rpc, RpcGroup } from "effect/rpc";
import { ToolCallStatus } from "./conversation-state.ts";

/** A person's answer to a Bot's request for a secret, as the card sends it over `Secret.answer`. */
export type SentAnswer = Rpc.Payload<
  Rpc.ExtractTag<RpcGroup.Rpcs<typeof SecretRpcs>, "Secret.answer">
>;

/** What the server said to the person's answer: taken, or refused and why. Never the secret. */
export type SecretReply = Data.TaggedEnum<{
  Taken: { readonly answer: SecretAnswer["_tag"] };
  Refused: { readonly message: string };
}>;

/** Constructors and matchers for {@link SecretReply}. */
export const SecretReply = Data.taggedEnum<SecretReply>();

/**
What a request's card shows. `Opening` while the Bot's call runs but the server shows no request for it
yet, as while its ref is judged. `Asking` while the Bot waits for the person, with the request as the
server shows it, their answer on its way or why the last one was refused. `Answered` once the server
took it. `NotTyped` when the person supplied it but the call then failed, so nothing was typed: a person
took the computer, or the computer refused the field. `Ended` when the call ended with no answer from
this page: it timed out, the turn stopped, or a rule refused it.
*/
export type SecretEntry = Data.TaggedEnum<{
  Opening: Record<never, never>;
  Asking: {
    readonly request: PendingSecret;
    readonly sending: boolean;
    readonly problem: Option.Option<string>;
  };
  Answered: { readonly answer: SecretAnswer["_tag"] };
  NotTyped: Record<never, never>;
  Ended: Record<never, never>;
}>;

/** Constructors and matchers for {@link SecretEntry}. */
export const SecretEntry = Data.taggedEnum<SecretEntry>();

/**
The card of a request whose call stands at `status`, while the server shows `pending` for its Bot, and
whose person's last answer is `last`.
*/
export function secretEntry(
  status: ToolCallStatus,
  pending: Option.Option<PendingSecret>,
  last: AsyncResult.AsyncResult<SecretReply>,
): SecretEntry {
  const reply = last.waiting ? Option.none() : AsyncResult.value(last);
  const taken = Option.filter(reply, SecretReply.$is("Taken"));

  if (Option.isSome(taken)) {
    const { answer } = taken.value;

    return answer === "Supplied" && ToolCallStatus.$is("Failed")(status)
      ? SecretEntry.NotTyped()
      : SecretEntry.Answered({ answer });
  }

  if (!ToolCallStatus.$is("Running")(status)) return SecretEntry.Ended();

  return Option.match(pending, {
    onNone: () => SecretEntry.Opening(),
    onSome: (request) =>
      SecretEntry.Asking({
        request,
        sending: last.waiting,
        problem: Option.map(
          Option.filter(reply, SecretReply.$is("Refused")),
          ({ message }) => message,
        ),
      }),
  });
}
