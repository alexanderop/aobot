import { Effect, Option, type Schema } from "effect";
import { AuditLog, type AuditRowId, type Outcome } from "../audit/public.ts";

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

  return { decide, outcome, settle };
});
