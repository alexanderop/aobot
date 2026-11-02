import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { SecretValue } from "./computer.ts";
import { BotId } from "./ids.ts";

/**
How a person answers a Bot's `request_secret`: the secret, which goes from the server straight to the
computer and never into the conversation, or no.
*/
export const SecretAnswer = Schema.TaggedUnion({
  Supplied: { value: SecretValue },
  Declined: {},
});

/** A decoded {@link SecretAnswer}. */
export type SecretAnswer = typeof SecretAnswer.Type;

/** The id the server gives one Bot's request for a secret, so an answer reaches only that request. */
export const SecretRequestId = Schema.String.pipe(Schema.brand("SecretRequestId"));

/** A decoded {@link SecretRequestId}. */
export type SecretRequestId = typeof SecretRequestId.Type;

/**
A Bot's request for a secret as its person is shown it: the field, as the Bot named it, and the host of
the page the field is on, as the server read it, so a Bot cannot pass one site's field off as another's.
*/
export const PendingSecret = Schema.Struct({
  request: SecretRequestId,
  field: Schema.String,
  host: Schema.String,
});

/** A decoded {@link PendingSecret}. */
export type PendingSecret = typeof PendingSecret.Type;

/** The Bot is waiting for no such secret: it never asked, or that request was answered, timed out or stopped. */
export class NoSecretRequested extends Schema.TaggedError<NoSecretRequested>()(
  "NoSecretRequested",
  { message: Schema.String },
) {}

/**
A person answering the secret a Bot asked for. `Secret.pending` streams the request the Bot waits on, the
current one first, and never fails. `Secret.answer` hands the answer to that request, named by its id,
and returns; what the computer then does with it, the Bot's tool call says.
*/
export class SecretRpcs extends RpcGroup.make(
  Rpc.make("Secret.pending", {
    payload: { bot: BotId },
    success: Schema.OptionFromNullOr(PendingSecret),
    stream: true,
  }),
  Rpc.make("Secret.answer", {
    payload: { bot: BotId, request: SecretRequestId, answer: SecretAnswer },
    error: NoSecretRequested,
  }),
) {}
