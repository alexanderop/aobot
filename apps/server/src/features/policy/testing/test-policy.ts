import { Result } from "effect";
import { policyLayer } from "../policy.ts";
import type { Rules } from "../rules.ts";
import { readRulesFile } from "../rules-file.ts";

/** The rules a `rules.yaml` holding `text` defines. Throws when it is not valid. */
export function rulesFrom(text: string): Rules {
  return Result.getOrThrow(readRulesFile(text));
}

/** A policy judging by the rules a `rules.yaml` holding `text` defines. */
export function policyFrom(text: string) {
  return policyLayer(rulesFrom(text));
}

/** A policy whose one allow rule allows every action, so only the grant and the gateway's checks refuse. */
export const allowEverything = policyFrom(`deny: []
allow:
  - name: everything
    when: "true"
`);
