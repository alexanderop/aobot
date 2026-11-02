import { answerLabels, ApprovalAnswer, ApprovalAnsweredBy, type AuditRow } from "@aobot/domain";
import { Option, Schema } from "effect";

/** Why a row's action was decided as it was, as its detail says: the rule that decided, and the reason. */
interface Why {
  readonly rule: Option.Option<string>;
  readonly reason: Option.Option<string>;
}

const decodeRule = Schema.decodeUnknownOption(Schema.Struct({ rule: Schema.NonEmptyString }));

const decodeReason = Schema.decodeUnknownOption(Schema.Struct({ reason: Schema.NonEmptyString }));

const decodeAnswer = Schema.decodeUnknownOption(
  Schema.Struct({ answer: ApprovalAnswer, by: ApprovalAnsweredBy }),
);

/**
The rule and the reason `row`'s detail names, each when it names one as text. A person's answer to an
approval reads as its reason, with who or what gave it, such as "No (time limit)".
*/
export function whyOf(row: AuditRow): Why {
  const answered = Option.map(
    decodeAnswer(row.detail),
    ({ answer, by }) => `${answerLabels[answer].label} (${by})`,
  );

  return {
    rule: Option.map(decodeRule(row.detail), ({ rule }) => rule),
    reason: Option.orElse(
      Option.map(decodeReason(row.detail), ({ reason }) => reason),
      () => answered,
    ),
  };
}
