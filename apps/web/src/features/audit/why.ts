import type { AuditRow } from "@aobot/domain";
import { Option, Schema } from "effect";

/** Why a row's action was decided as it was, as its detail says: the rule that decided, and the reason. */
interface Why {
  readonly rule: Option.Option<string>;
  readonly reason: Option.Option<string>;
}

const decodeRule = Schema.decodeUnknownOption(Schema.Struct({ rule: Schema.NonEmptyString }));

const decodeReason = Schema.decodeUnknownOption(Schema.Struct({ reason: Schema.NonEmptyString }));

/** The rule and the reason `row`'s detail names, each when it names one as text. */
export function whyOf(row: AuditRow): Why {
  return {
    rule: Option.map(decodeRule(row.detail), ({ rule }) => rule),
    reason: Option.map(decodeReason(row.detail), ({ reason }) => reason),
  };
}
