# Quality gates

Copied from the setup in `~/Projects/games/effect-factory`, adapted to aobot. Rules are enforced by
tools, never by documents alone: if a rule matters, a lint rule or a test fails when it is broken.

## The one command

```sh
bun run check   # typecheck && lint && test && knip
```

Run it before calling anything done. CI runs the same command (effect-factory has no CI; aobot adds it
in [E0-4](backlog/E0-walking-skeleton/E0-4-quality-gates-and-ci.md)).

| Script | What it runs | In `check`? |
| --- | --- | --- |
| `typecheck` | `tsc --noEmit` per workspace | yes |
| `lint` | `oxlint --deny-warnings` with the plugins below | yes |
| `test` | Vitest projects `unit`, `services`, `architecture` | yes |
| `knip` | unused files, exports and dependencies | yes |
| `test:contract` | tier 3, needs Docker | no, CI job |
| `test:slow` | anything over a few seconds (`*.slow.test.ts`) | no |
| `verify <ticket>` | tier 4: the ticket's demo in a real browser through `agent-browser`, screenshot saved to `verify/` | no, CI job |

## TypeScript

The same compiler options as effect-factory:

- `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`
- `verbatimModuleSyntax`, `noUncheckedSideEffectImports`, `allowImportingTsExtensions`
- `moduleResolution: "bundler"`, internal imports through `package.json` `"imports"` (`#/…`)

## oxlint

`.oxlintrc.json` loads four JS plugin sets. Every rule is `error`; there are no warnings.

| Plugin | Source | What it enforces |
| --- | --- | --- |
| `anti-slop` | Vendored from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) with its install script. Record the commit in `tools/oxlint/anti-slop/UPSTREAM.md` | 18 generic rules: no `unknown` parameters or returns, no chained or widening type assertions, a safety comment on every assertion, no module mocking, no object parameters, no `Reflect.get`, readable spacing |
| `anti-slop-effect` | Same repository | No hand-written `_tag` errors, comparisons or construction; no service constructor imports; prefer `Effect.match` |
| `aobot-standards` | Copy of effect-factory's `tools/oxlint/factory-standards` | Import Effect modules from `"effect"`, model optional values as `Option`, narrow tagged errors by tag not `instanceof`, justify every `!`, JSDoc on every export |
| `aobot-architecture` | Adapted from effect-factory's `tools/oxlint/factory-architecture` | The dependency graph below, declared in `policy.ts`, checked acyclic by a test |

Built-in rules on top: `typescript/no-explicit-any`, `oxc/no-accumulating-spread`.

### aobot's architecture rules

The declared graph, in `tools/oxlint/aobot-architecture/policy.ts`:

```ts
export const dependencies = new Map([
  ["domain", []],                        // packages/domain: schemas only
  ["computer", ["domain"]],              // apps/computer
  ["server", ["domain"]],                // apps/server
  ["web", ["domain"]],                   // apps/web: never imports server code
  ["desktop", ["web", "domain"]],        // apps/desktop
])
```

Restricted imports, globals and properties, as in effect-factory's overrides:

| Where | Rule | Why |
| --- | --- | --- |
| everywhere except `apps/server/src/gateway/**` | no import of the computer client | Every action goes through the gateway |
| everywhere except `**/config.ts` layers | no `process.env` | Settings go through Effect `Config` |
| `packages/domain/**`, `apps/server/src/policy/**`, `redact.ts` | no `Date.now`, `Math.random`, `performance.now` | Decisions and redaction are pure and repeatable in tests |
| `apps/web/**` | no import from `apps/server` | The page talks to the server only through `packages/domain` schemas |
| `apps/server/**` | no `console.*` | Logs go through Effect's logger so they carry the `trace_id` |

Overrides switch the restrictions off for `*.test.ts` and `testing/**`, as effect-factory does.

### The lint rules have tests

Custom rules are code, so they are tested. A Vitest project named `architecture` runs
`tools/oxlint/aobot-{architecture,standards}/**/*.test.ts` inside `check`, including the test that the
declared graph is acyclic.

## knip

Explicit `entry` and `project` globs per workspace, `ignoreBinaries: ["agent-browser"]`. Unused files,
exports and dependencies fail `check`.

## Tests that keep docs honest

effect-factory has `feature-map.test.ts`: it fails when a key binding or command is missing from the
docs. aobot has two of the same kind:

- **Tool map test.** Every tool the gateway accepts appears in `docs/architecture.md`, with its audit
  row shape. Adding a tool without documenting it fails `check`.
- **Ticket demo test.** Every ticket with `status: done` has a `verify` scenario with the same id.
  Marking a ticket done without an automated demo fails `check`.

## Issue templates

`.github/ISSUE_TEMPLATE/` has `slice.yml`, `bug.yml` and `chore.yml` with blank issues off, the same
shape as effect-factory. A slice follows [ticket-template.md](ticket-template.md).

## Agent instructions

`CLAUDE.md` (with `AGENTS.md` as a symlink to it) lists the commands above and the rule: run
`bun run check` before calling anything done, and prove a slice with `bun run verify <ticket>`.
