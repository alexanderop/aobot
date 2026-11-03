import type { ASTNode, ParseResult } from "@marcbachmann/cel-js";
import { Effect, Result, Schema } from "effect";
import { parseYaml } from "../../shared/yaml.ts";
import { blankFacts, type Facts, factsEnvironment } from "./facts.ts";
import { type Rule, RuleName, type Rules } from "./rules.ts";

const decodeAnswer = Schema.decodeUnknownResult(Schema.Boolean);

/**
What a parsed rule answers on `facts`: true or false, or why it gave neither. Evaluating can throw, and CEL
hands back any value, so the answer is read here.
*/
function answerOf(evaluate: ParseResult) {
  return (facts: Facts): Result.Result<boolean, string> =>
    Result.try({
      try: () => evaluate(facts),
      catch: (error) => (error instanceof Error ? error.message : String(error)),
    }).pipe(
      Result.flatMap((value) =>
        decodeAnswer(value).pipe(Result.mapError(() => "it answered neither true nor false")),
      ),
    );
}

/** The expressions directly under `node`. */
function children(node: ASTNode): ReadonlyArray<ASTNode> {
  switch (node.op) {
    case "value":
    case "id":
      return [];
    case ".":
    case ".?":
      return [node.args[0]];
    case "call":
      return node.args[1];
    case "rcall":
      return [node.args[1], ...node.args[2]];
    case "map":
      return node.args.flat();
    case "!_":
    case "-_":
      return [node.args];
    default:
      return node.args;
  }
}

/** Whether `node`, or anything under it, calls `matches`, as a method or as a function. */
function callsMatches(node: ASTNode): boolean {
  const calls = (node.op === "call" || node.op === "rcall") && node.args[0] === "matches";

  return calls || children(node).some(callsMatches);
}

/**
`true` when `when` can be a rule, or why not: it does not parse, names a field the facts do not have, does
not answer true or false, calls `matches`, or fails on {@link blankFacts}. A `dyn` answer is refused too,
since only evaluating it would tell. `matches` runs a backtracking regular
expression on the server's one thread, where one pattern can stall every turn.
*/
function checkWhen(when: string): true | string {
  const checked = factsEnvironment.check(when);

  if (!checked.valid) return checked.error?.summary ?? "it is not a valid expression";

  if (checked.type !== "bool") return `it answers ${checked.type ?? "nothing"}, not true or false`;

  const parsed = factsEnvironment.parse(when);

  if (callsMatches(parsed.ast)) {
    return "matches is not allowed, since a regular expression can stall the server; use contains, startsWith, endsWith or lowerAscii()";
  }

  return Result.match(answerOf(parsed)(blankFacts), {
    onSuccess: () => true,
    onFailure: (error) =>
      `it fails when page.host, element, key, command and file are "": ${error}`,
  });
}

const RuleEntry = Schema.Struct({
  name: RuleName,
  when: Schema.String.check(Schema.makeFilter(checkWhen)),
});

type RuleEntry = typeof RuleEntry.Type;

const RuleLists = Schema.Struct({
  deny: Schema.Array(RuleEntry),
  allow: Schema.Array(RuleEntry),
  ask: Schema.Array(RuleEntry).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
});

/** Each rule after the first with a name an earlier one in any list has. */
const uniqueNames = Schema.makeFilter(({ deny, allow, ask }: typeof RuleLists.Type) => {
  const all = [
    ...deny.map((rule, index) => ["deny", index, rule.name] as const),
    ...allow.map((rule, index) => ["allow", index, rule.name] as const),
    ...ask.map((rule, index) => ["ask", index, rule.name] as const),
  ];

  return all.flatMap(([list, index, name], position) =>
    all.findIndex(([, , other]) => other === name) < position
      ? [{ path: [list, index, "name"], issue: `${name} names two rules` }]
      : [],
  );
});

/**
`rules.yaml`: the deny rules and the allow rules, each list present though it may be empty, and the ask
rules, which a file can leave out.
*/
const RulesFile = RuleLists.check(uniqueNames);

// A misspelt key, such as `alow:`, is an error rather than a list silently left empty.
const decodeRulesFile = Schema.decodeUnknownResult(RulesFile, {
  onExcessProperty: "error",
  errors: "all",
});

/** A checked entry as the rule it is, its expression parsed once, here. */
function compile({ name, when }: RuleEntry): Rule {
  return { name, answer: answerOf(factsEnvironment.parse(when)) };
}

/**
The rules `text` defines, or why it is not a valid rules file: empty, not YAML, the deny or allow list
missing or a key misspelt, a name that is not a slug or names two rules, or a `when` that does not parse,
names a field the facts do not have, does not answer true or false, calls `matches`, or fails when
`page.host`, `element`, `key`, `command` and `file` are `""`. Every problem is named, not just the first.
*/
export function readRulesFile(text: string): Result.Result<Rules, string> {
  return parseYaml(text).pipe(
    Result.flatMap((contents) =>
      decodeRulesFile(contents).pipe(Result.mapError((error) => error.message)),
    ),
    Result.map(({ deny, allow, ask }) => ({
      deny: deny.map(compile),
      allow: allow.map(compile),
      ask: ask.map(compile),
    })),
  );
}
