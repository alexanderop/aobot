import { Result, Schema } from "effect";
import type { Facts } from "./facts.ts";

/**
A rule in `rules.yaml`, such as `no-rm-rf`: up to 64 lowercase letters, digits and dashes, since it is
written into the audit row and the answer of every action it refuses.
*/
export const RuleName = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(64), Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/u)),
  Schema.brand("RuleName"),
);

/** A decoded {@link RuleName}. */
export type RuleName = typeof RuleName.Type;

/**
A rule as the rules file defines it, checked when the file was read. `answer` evaluates its CEL expression
on one action's facts: true or false, or why it gave neither, as when a regular expression in it is not one.
*/
export interface Rule {
  readonly name: RuleName;
  readonly answer: (facts: Facts) => Result.Result<boolean, string>;
}

/** Every rule, each list in the order the file gives it. */
export interface Rules {
  readonly deny: ReadonlyArray<Rule>;
  readonly allow: ReadonlyArray<Rule>;
}

/** A rule that failed while it was checked, and why. `error` can echo what the action holds. */
const FailedRule = Schema.Struct({ rule: RuleName, error: Schema.String });

/**
What the rules make of one action. `Allowed` and `NoneAllowed` carry the allow rules that failed on the
way, each counted as not matching. `DenyRuleFailed` is a deny rule that failed, which refuses. A failed
rule's `error` can echo what the action holds, so it goes into the audit row only.
*/
export const Verdict = Schema.TaggedUnion({
  Allowed: { rule: RuleName, broken: Schema.Array(FailedRule) },
  Denied: { rule: RuleName },
  DenyRuleFailed: { rule: RuleName, error: Schema.String },
  NoneAllowed: { broken: Schema.Array(FailedRule) },
});

/** A decoded {@link Verdict}. */
export type Verdict = typeof Verdict.Type;

const { Allowed, Denied, DenyRuleFailed, NoneAllowed } = Verdict.cases;

/** A {@link Verdict} that refuses the action: every one but `Allowed`. */
export const Refused = Schema.Union([Denied, DenyRuleFailed, NoneAllowed]).pipe(
  Schema.toTaggedUnion("_tag"),
);

/** A decoded {@link Refused}. */
export type Refused = typeof Refused.Type;

/**
The {@link Verdict} of `rules` on one action. Every deny rule in order: the first that holds or fails
refuses. Then every allow rule in order: the first that holds allows. Anything else is refused.
*/
export function judge(rules: Rules, facts: Facts): Verdict {
  for (const rule of rules.deny) {
    const denies = rule.answer(facts);

    if (Result.isFailure(denies)) {
      return DenyRuleFailed.make({ rule: rule.name, error: denies.failure });
    }

    if (denies.success) return Denied.make({ rule: rule.name });
  }

  const broken: Array<typeof FailedRule.Type> = [];

  for (const rule of rules.allow) {
    const allows = rule.answer(facts);

    if (Result.isFailure(allows)) {
      broken.push({ rule: rule.name, error: allows.failure });
    } else if (allows.success) {
      return Allowed.make({ rule: rule.name, broken });
    }
  }

  return NoneAllowed.make({ broken });
}
