import { Result } from "effect";
import type { Rules } from "../rules.ts";
import { readRulesFile } from "../rules-file.ts";

/** The rules a `rules.yaml` holding `text` defines. Throws when it is not valid. */
export function rulesFrom(text: string): Rules {
  return Result.getOrThrow(readRulesFile(text));
}
