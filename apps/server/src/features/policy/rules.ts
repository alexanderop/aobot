import { Option, Result, Schema } from "effect";
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
  readonly ask: ReadonlyArray<Rule>;
}

/** A rule that failed while it was checked, and why. `error` can echo what the action holds. */
const FailedRule = Schema.Struct({ rule: RuleName, error: Schema.String });

/** The ask rule an allowed action waits on the person's yes for, which `failed` when it could not be checked. */
const AskRule = Schema.Struct({ rule: RuleName, failed: Schema.Boolean });

/**
What the rules make of one action. `Allowed` and `NoneAllowed` carry the allow rules that failed on the
way, each counted as not matching. An `Allowed` action with an `ask` rule runs only once the person says
yes. `DenyRuleFailed` is a deny rule that failed, which refuses. A failed rule's `error` can echo what the
action holds, so it goes into the audit row only.
*/
export const Verdict = Schema.TaggedUnion({
  Allowed: { rule: RuleName, broken: Schema.Array(FailedRule), ask: Schema.Option(AskRule) },
  Denied: { rule: RuleName },
  DenyRuleFailed: { rule: RuleName, error: Schema.String },
  NoneAllowed: { broken: Schema.Array(FailedRule) },
});

/** A decoded {@link Verdict}. */
export type Verdict = typeof Verdict.Type;

const { Allowed, Denied, DenyRuleFailed, NoneAllowed } = Verdict.cases;

/** A {@link Verdict} that lets the action run, at once or once the person says yes. */
export type Allowed = typeof Allowed.Type;

/** A {@link Verdict} that refuses the action: every one but `Allowed`. */
export const Refused = Schema.Union([Denied, DenyRuleFailed, NoneAllowed]).pipe(
  Schema.toTaggedUnion("_tag"),
);

/** A decoded {@link Refused}. */
export type Refused = typeof Refused.Type;

/** The first of the allow rules `allow` that holds on `facts`, and each one that failed before it. */
function firstAllowing(allow: ReadonlyArray<Rule>, facts: Facts) {
  const broken: Array<typeof FailedRule.Type> = [];

  for (const rule of allow) {
    const allows = rule.answer(facts);

    if (Result.isFailure(allows)) {
      broken.push({ rule: rule.name, error: allows.failure });
    } else if (allows.success) {
      return { allowedBy: Option.some(rule.name), broken };
    }
  }

  return { allowedBy: Option.none<RuleName>(), broken };
}

/**
The {@link Verdict} of `rules` on one action. Every deny rule in order: the first that holds or fails
refuses. Then every allow rule in order: the first that holds allows, and anything none allows is refused.
Then every ask rule in order: the first that holds or fails asks the person first. An ask rule is read
only once an allow rule held, so adding one never allows anything.
*/
export function judge(rules: Rules, facts: Facts): Verdict {
  for (const rule of rules.deny) {
    const denies = rule.answer(facts);

    if (Result.isFailure(denies)) {
      return DenyRuleFailed.make({ rule: rule.name, error: denies.failure });
    }

    if (denies.success) return Denied.make({ rule: rule.name });
  }

  const { allowedBy, broken } = firstAllowing(rules.allow, facts);

  if (Option.isNone(allowedBy)) return NoneAllowed.make({ broken });

  const allowed = (ask: Option.Option<typeof AskRule.Type>) =>
    Allowed.make({ rule: allowedBy.value, broken, ask });

  for (const rule of rules.ask) {
    const asks = rule.answer(facts);
    const failed = Result.isFailure(asks);

    if (failed || asks.success) return allowed(Option.some({ rule: rule.name, failed }));
  }

  return allowed(Option.none());
}
