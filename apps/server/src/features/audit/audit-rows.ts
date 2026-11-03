import type { AuditAction, InitiatorKind } from "@aobot/domain";
import { Effect, Option, type Schema } from "effect";
import { AuditLog, type AuditRowId, type Decision, type Outcome, singleUser } from "./audit-log.ts";

/** The decision of a row that refuses an action: `deny`, or `hand_off` for one that is always the person's. */
export type RefusalDecision = Extract<Decision, "deny" | "hand_off">;

/**
The rows written for `initiatorKind`, each in the trace that wrote it. Each is on the authority of the one
person using this server: no sign-in exists yet, so it is `single-user` until E3 brings people, and an
`acp` turn only runs in single-user mode, so even what a Bot asked for was that person's.
*/
export const auditRows = (initiatorKind: InitiatorKind) =>
  Effect.gen(function* () {
    const audit = yield* AuditLog;

    /** A decision about `action`, in the trace that asked for it. */
    const decide = (decision: Decision, action: AuditAction, detail: Schema.JsonObject) =>
      Effect.flatMap(Effect.option(Effect.currentSpan), (span) =>
        audit.record({
          traceId: Option.map(span, (current) => current.traceId),
          initiatorKind,
          actorId: singleUser,
          decision,
          action,
          detail,
        }),
      );

    /**
    A `deny` or `hand_off` row for `action`, only logged when it cannot be written: what was refused did
    not happen either way, so the refusal still stands.
    */
    const refuse = (decision: RefusalDecision, action: AuditAction, detail: Schema.JsonObject) =>
      decide(decision, action, detail).pipe(
        Effect.asVoid,
        Effect.catchTag("AuditWriteFailed", (error) =>
          Effect.logError("A refusal row could not be written").pipe(
            Effect.annotateLogs({ action, decision, reason: error.message }),
          ),
        ),
      );

    /** What became of the action `allowRow` allowed. */
    const outcome = (allowRow: AuditRowId, result: Outcome, detail: Schema.JsonObject) =>
      audit.recordOutcome({ allowRow, initiatorKind, outcome: result, detail });

    /**
    {@link outcome}, only logged when it cannot be written. The start-up sweep turns a missing outcome
    into `unknown`, so this never needs a retry.
    */
    const settle = (allowRow: AuditRowId, result: Outcome, detail: Schema.JsonObject) =>
      outcome(allowRow, result, detail).pipe(
        Effect.catchTag("AuditWriteFailed", (error) =>
          Effect.logWarning("An outcome row could not be written").pipe(
            Effect.annotateLogs({ allowRow, outcome: result, reason: error.message }),
          ),
        ),
      );

    return { decide, refuse, outcome, settle };
  });
