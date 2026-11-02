import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotId } from "@aobot/domain";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { Policy, policyFileLayer } from "./policy.ts";
import { RuleName, Verdict } from "./rules.ts";

/** Builds {@link Policy} from the file at `path`, as a server start does, and answers why it failed. */
const startFailure = (path: string) =>
  Effect.flip(
    Layer.build(policyFileLayer(path).pipe(Layer.provide(NodeFileSystem.layer))).pipe(
      Effect.scoped,
    ),
  );

function writtenFile(text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "aobot-rules-")), "rules.yaml");
  writeFileSync(path, text);

  return path;
}

describe("policyFileLayer", () => {
  it.effect("stops start-up naming the file when there is none", () =>
    Effect.gen(function* () {
      const missing = join(tmpdir(), "aobot-no-such-dir", "rules.yaml");
      const error = yield* startFailure(missing);

      expect(error.message).toContain(`${missing} is not a valid rules file: `);
    }),
  );

  it.effect("stops start-up naming the file and why it is not valid", () =>
    Effect.gen(function* () {
      const path = writtenFile("deny: []\n");
      const error = yield* startFailure(path);

      expect(error.message).toContain(`${path} is not a valid rules file: `);
      expect(error.message).toContain('["allow"]');
    }),
  );

  it.effect("judges each action by the rules a valid file holds", () =>
    Effect.gen(function* () {
      const path = writtenFile(`deny:
  - name: no-rm-rf
    when: command.contains("rm -rf")
allow:
  - name: granted-tools
    when: "true"
`);

      const verdict = yield* Policy.use((policy) =>
        Effect.succeed(
          policy.judge({
            tool: { name: "run" },
            bot: { id: BotId.make("assistant") },
            actor: { id: "single-user" },
            computer: { kind: "cloud" },
            page: { host: "" },
            element: { role: "", name: "" },
            key: "",
            command: "rm -rf /tmp/x",
            file: { path: "", name: "", extension: "" },
          }),
        ),
      ).pipe(Effect.provide(policyFileLayer(path).pipe(Layer.provide(NodeFileSystem.layer))));

      expect(verdict).toEqual(Verdict.cases.Denied.make({ rule: RuleName.make("no-rm-rf") }));
    }),
  );
});
