import { Context, Effect, FileSystem, Layer, Result, Schema } from "effect";
import type { Facts } from "./facts.ts";
import { judge, type Rules, type Verdict } from "./rules.ts";
import { readRulesFile } from "./rules-file.ts";

/** The rules every Bot action is judged by, read once at start-up. */
export class Policy extends Context.Service<
  Policy,
  {
    /** The {@link Verdict} of the rules on one action. Pure: a rule that failed is part of the answer. */
    readonly judge: (facts: Facts) => Verdict;
  }
>()("aobot/policy/Policy") {}

/** The rules file could not be read or is not valid, so the server does not start. */
class RulesFileInvalid extends Schema.TaggedError<RulesFileInvalid>()("RulesFileInvalid", {
  message: Schema.String,
}) {}

/** {@link Policy} judging by `rules`. */
export function policyLayer(rules: Rules): Layer.Layer<Policy> {
  return Layer.succeed(Policy, Policy.of({ judge: (facts) => judge(rules, facts) }));
}

/** {@link Policy} from the YAML file at `path`, failing start-up with the reason when it is not valid. */
export function policyFileLayer(path: string) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      const invalid = (reason: string) =>
        new RulesFileInvalid({ message: `${path} is not a valid rules file: ${reason}` });

      const text = yield* fs
        .readFileString(path)
        .pipe(Effect.mapError((error) => invalid(error.message)));

      const rules = yield* Effect.fromResult(Result.mapError(readRulesFile(text), invalid));

      if (rules.allow.length === 0) {
        yield* Effect.logWarning(
          "The rules file has no allow rule, so every Bot action is refused",
        ).pipe(Effect.annotateLogs({ path }));
      }

      return policyLayer(rules);
    }),
  );
}
