import { answerLabels, ApprovalAnswer, ApprovalAnsweredBy, type AuditRow } from "@aobot/domain";
import { Option, Schema } from "effect";

/**
Why a row's action was decided as it was, as its detail says: what decided it, a rule or the safety list,
and the reason.
*/
interface Why {
  readonly decidedBy: Option.Option<string>;
  readonly reason: Option.Option<string>;
}

const decodeRule = Schema.decodeUnknownOption(Schema.Struct({ rule: Schema.NonEmptyString }));

const decodeSafety = Schema.decodeUnknownOption(Schema.Struct({ safety: Schema.NonEmptyString }));

const decodeReason = Schema.decodeUnknownOption(Schema.Struct({ reason: Schema.NonEmptyString }));

const decodeAnswer = Schema.decodeUnknownOption(
  Schema.Struct({ answer: ApprovalAnswer, by: ApprovalAnsweredBy }),
);

/**
The rule and the reason `row`'s detail names, each when it names one as text. A `hand_off` row is
decided by the safety list it names, such as `safety:credentials`, also when it names the ask rule the
person had been asked under. A person's answer to an approval reads as its reason, with who or what
gave it, such as "No (time limit)".
*/
export function whyOf(row: AuditRow): Why {
  const answered = Option.map(
    decodeAnswer(row.detail),
    ({ answer, by }) => `${answerLabels[answer].label} (${by})`,
  );

  const safety = row.decision === "hand_off" ? decodeSafety(row.detail) : Option.none();

  return {
    decidedBy: Option.orElse(
      Option.map(safety, ({ safety }) => `safety:${safety}`),
      () => Option.map(decodeRule(row.detail), ({ rule }) => rule),
    ),
    reason: Option.orElse(
      Option.map(decodeReason(row.detail), ({ reason }) => reason),
      () => answered,
    ),
  };
}
