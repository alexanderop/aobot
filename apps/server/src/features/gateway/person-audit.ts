import { Effect, Match, Option, type Schema } from "effect";
import { AuditLog, type AuditRowId, type Outcome } from "../audit/public.ts";
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

/**
The gateway's audit rows. Each is on the authority of the one person using this server: no sign-in exists
yet, so it is `single-user` until E3 brings people, and an `acp` turn only runs in single-user mode, so
even what a Bot asked for was that person's.
*/
export const personAudit = Effect.gen(function* () {
  const audit = yield* AuditLog;

  /** A decision about `action`, in the trace that asked for it. */
  const decide = (decision: "allow" | "deny", action: string, detail: Schema.JsonObject) =>
    Effect.flatMap(Effect.option(Effect.currentSpan), (span) =>
      audit.record({
        traceId: Option.map(span, (current) => current.traceId),
        initiatorKind: "person",
        actorId: "single-user",
        decision,
        action,
        detail,
      }),
    );

  /**
  A `deny` row for `action`, only logged when it cannot be written: what was denied did not happen either
  way, so the refusal still stands.
  */
  const deny = (action: string, detail: Schema.JsonObject) =>
    decide("deny", action, detail).pipe(
      Effect.asVoid,
      Effect.catchTag("AuditWriteFailed", (error) =>
        Effect.logError("A deny row could not be written").pipe(
          Effect.annotateLogs({ action, reason: error.message }),
        ),
      ),
    );

  /** What became of the action `allowRow` allowed. */
  const outcome = (allowRow: AuditRowId, result: Outcome, detail: Schema.JsonObject) =>
    audit.recordOutcome({ allowRow, initiatorKind: "person", outcome: result, detail });

  /**
  {@link outcome}, only logged when it cannot be written. The start-up sweep turns a missing outcome into
  `unknown`, so this never needs a retry.
  */
  const settle = (allowRow: AuditRowId, result: Outcome, detail: Schema.JsonObject) =>
    outcome(allowRow, result, detail).pipe(
      Effect.catchTag("AuditWriteFailed", (error) =>
        Effect.logWarning("An outcome row could not be written").pipe(
          Effect.annotateLogs({ allowRow, outcome: result, reason: error.message }),
        ),
      ),
    );

  return { decide, deny, outcome, settle };
});
