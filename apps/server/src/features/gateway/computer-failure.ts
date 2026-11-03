import { Match, type Schema } from "effect";
import type { Outcome } from "../audit/public.ts";
import type { ComputerActFailed, ComputerLost, ComputerUnavailable } from "../computers/public.ts";
import { capText } from "../../shared/tool-result.ts";

/** The longest computer message kept in an audit row or shown to a person. */
export const computerMessageLimit = 500;

/** Why a call the gateway allowed did not come back from the computer with an answer. */
export type ComputerFailure = ComputerUnavailable | ComputerActFailed | ComputerLost;

/** The outcome row of an allowed call the computer did not carry out, whoever asked for it. */
export const failureOutcome = Match.typeTags<
  ComputerFailure,
  { readonly outcome: Outcome; readonly detail: Schema.JsonObject }
>()({
  ComputerUnavailable: ({ message }) => ({
    outcome: "failed",
    detail: { reason: "unavailable", message: capText(message, computerMessageLimit) },
  }),
  ComputerActFailed: ({ reason, message }) => ({
    outcome: "failed",
    detail: { reason, message: capText(message, computerMessageLimit) },
  }),
  ComputerLost: ({ message }) => ({
    outcome: "unknown",
    detail: { reason: "lost", message: capText(message, computerMessageLimit) },
  }),
});
