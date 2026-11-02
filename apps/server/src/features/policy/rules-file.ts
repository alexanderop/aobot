import { Result, Schema } from "effect";
import { parseYaml } from "../../shared/yaml.ts";
import { factsEnvironment } from "./facts.ts";
import { type Rule, RuleName, type Rules } from "./rules.ts";

/**
`true` when `when` can be a rule, or why not: it does not parse, names a field the facts do not have, or
does not answer true or false. A `dyn` answer is refused too, since only evaluating it would tell.
*/
function checkWhen(when: string): true | string {
  const checked = factsEnvironment.check(when);

  if (!checked.valid) return checked.error?.summary ?? "it is not a valid expression";

  return checked.type === "bool" || `it answers ${checked.type ?? "nothing"}, not true or false`;
}

const RuleEntry = Schema.Struct({
  name: RuleName,
  when: Schema.String.check(Schema.makeFilter(checkWhen)),
});

type RuleEntry = typeof RuleEntry.Type;

const RuleLists = Schema.Struct({
  deny: Schema.Array(RuleEntry),
  allow: Schema.Array(RuleEntry),
});

/** Each rule after the first with a name an earlier one in either list has. */
const uniqueNames = Schema.makeFilter(({ deny, allow }: typeof RuleLists.Type) => {
  const all = [
    ...deny.map((rule, index) => ["deny", index, rule.name] as const),
    ...allow.map((rule, index) => ["allow", index, rule.name] as const),
  ];

  return all.flatMap(([list, index, name], position) =>
    all.findIndex(([, , other]) => other === name) < position
      ? [{ path: [list, index, "name"], issue: `${name} names two rules` }]
      : [],
  );
});

/** `rules.yaml`: the deny rules and the allow rules, each list present though it may be empty. */
const RulesFile = RuleLists.check(uniqueNames);

// A misspelt key, such as `alow:`, is an error rather than a list silently left empty.
const decodeRulesFile = Schema.decodeUnknownResult(RulesFile, {
  onExcessProperty: "error",
  errors: "all",
});

const decodeAnswer = Schema.decodeUnknownResult(Schema.Boolean);

/**
A checked entry as the rule it is, its expression parsed once, here. Evaluating it can still throw, and
CEL hands back any value, so its answer is read here too.
*/
function compile({ name, when }: RuleEntry): Rule {
  const evaluate = factsEnvironment.parse(when);

  return {
    name,
    answer: (facts) =>
      Result.try({
        try: () => evaluate(facts),
        catch: (error) => (error instanceof Error ? error.message : String(error)),
      }).pipe(
        Result.flatMap((value) =>
          decodeAnswer(value).pipe(Result.mapError(() => "it answered neither true nor false")),
        ),
      ),
  };
}

/**
The rules `text` defines, or why it is not a valid rules file: empty, not YAML, a list missing or a key
misspelt, a name that is not a slug or names two rules, or a `when` that does not parse, names a field the
facts do not have, or does not answer true or false. Every problem is named, not just the first.
*/
export function readRulesFile(text: string): Result.Result<Rules, string> {
  return parseYaml(text).pipe(
    Result.flatMap((contents) =>
      contents === null || contents === undefined
        ? Result.fail("the file is empty")
        : decodeRulesFile(contents).pipe(Result.mapError((error) => error.message)),
    ),
    Result.map(({ deny, allow }) => ({ deny: deny.map(compile), allow: allow.map(compile) })),
  );
}
