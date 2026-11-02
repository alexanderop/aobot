import { type BotId, SecretAnswer, type SecretRequestId } from "@aobot/domain";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { Option, Redacted } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";
import type { ToolCall } from "./conversation-state.ts";
import { secretEntry, type SecretEntry } from "./secret-entry.ts";
import { secretAnswer, secretPending } from "./secrets.ts";

/** A Bot's request for a secret, and how the person answers it. */
export interface UseSecretRequest {
  readonly entry: SecretEntry;
  /** Sends what the person typed straight to the Bot's waiting request `request`. */
  readonly supply: (request: SecretRequestId, secret: string) => void;
  readonly decline: (request: SecretRequestId) => void;
}

/** The request `call` made of `bot`'s person, shaped like the other chat hooks: values and functions. */
export function useSecretRequest(call: ToolCall, bot: BotId): UseSecretRequest {
  const pending = Option.flatten(AsyncResult.value(useAtomValue(secretPending(bot))));
  const [last, send] = useAtom(secretAnswer(call.id));

  return {
    entry: secretEntry(call.status, pending, last),
    supply: useCallback(
      (request: SecretRequestId, secret: string) =>
        send({
          bot,
          request,
          answer: SecretAnswer.cases.Supplied.make({ value: Redacted.make(secret) }),
        }),
      [bot, send],
    ),
    decline: useCallback(
      (request: SecretRequestId) =>
        send({ bot, request, answer: SecretAnswer.cases.Declined.make({}) }),
      [bot, send],
    ),
  };
}
