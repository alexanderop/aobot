import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { assert } from "../browser.ts";

/** Only runs `vp run check`, so it needs neither the compose stack nor the browser. */
export const stack = false;

const offender = "apps/server/src/features/chat/reads-env.ts";

/** E0-4: a server service that reads `process.env.FOO` fails the CI command, and the failure names the rule. */
export default async function scenario(): Promise<void> {
  writeFileSync(
    offender,
    "/** Reads FOO straight from the environment. */\nexport const foo = process.env.FOO;\n",
  );

  try {
    const check = spawnSync("vp", ["run", "check"], { encoding: "utf8" });
    const output = `${check.stdout}${check.stderr}`;
    console.log(output);

    assert(check.status !== 0, "vp run check fails");
    assert(output.includes("eslint(no-restricted-properties)"), "the failure names the rule");
    assert(output.includes(offender), "the failure names the offending file");
  } finally {
    rmSync(offender, { force: true });
  }
}
