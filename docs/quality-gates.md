---
title: Quality gates
description: "Copied from the setup in ~/Projects/games/effect-factory, adapted to aobot. Rules are enforced by tools, never by documents alone: if a rule matters, a lint rule or a test fails when it is broken."
---

# Quality gates

Copied from the setup in `~/Projects/games/effect-factory`, adapted to aobot. Rules are enforced by
tools, never by documents alone: if a rule matters, a lint rule or a test fails when it is broken.

## The toolchain: Vite+

aobot uses [Vite+](https://viteplus.dev) (`vp`) as its one toolchain, like effect-factory's
`chore/vite-plus` branch. It bundles oxlint, oxfmt, Vitest and a type-aware checker, and it installs
the pinned Node and pnpm itself. All configuration lives in `vite.config.ts`; the lint rules live in
`tools/oxlint/config.ts`, which both `vite.config.ts` and the rule tests import.

## The one command

```sh
vp run check   # vp check (format, lint, type-check) && vp test run && knip
```

Run it before calling anything done. CI (`.github/workflows/ci.yml`) runs the same command on every
push to `main` and every pull request, after `voidzero-dev/setup-vp`. effect-factory has no CI; aobot
adds it. Note that `vp check` alone is the built-in static check; `vp run check` runs the full script.

| Command                  | What it runs                                                                                                  | In `check`? |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- | ----------- |
| `vp check`               | oxfmt formatting, oxlint with the plugins below, and type-checking (`lint.options.typeAware` and `typeCheck`) | yes         |
| `vp test run`            | Vitest projects `unit` (every workspace's tests) and `architecture` (lint rules and backlog)                  | yes         |
| `knip`                   | unused files, exports and dependencies                                                                        | yes         |
| `vp check --fix`         | formats and applies autofixes                                                                                 | no          |
| `vp run test:contract`   | tier 3, needs Docker (arrives with E1-1)                                                                      | no, CI job  |
| `vp run verify <ticket>` | tier 4: the ticket's demo in a real browser through `agent-browser` (arrives with E0-1)                       | no, CI job  |

Pinned versions: Vite+ 1.4.0 (oxlint 1.89, Vitest 5.0.5), pnpm 11.28.10, knip 6.44.0, Effect 4.1.0.
pnpm 12 failed to install on macOS through Vite+ (`ENOEXEC`), so the project stays on pnpm 11 for now.

Imports follow Vite+: tests import from `vite-plus/test`, lint plugins from `vite-plus/lint/plugins`.
The `vite-plus/prefer-vite-plus-imports` rule enforces it.

## TypeScript

`vp check` type-checks with the options in `tsconfig.json`, the same as effect-factory: `strict`, `noUnusedLocals`, `noUnusedParameters`,
`noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `noUncheckedSideEffectImports`,
`allowImportingTsExtensions`, `moduleResolution: "bundler"`.

## oxlint

`tools/oxlint/config.ts` loads four JS plugin sets plus Vite+'s own plugin. Every rule is `error`; there are no warnings.

| Plugin               | Source                                                                                                                                               | What it enforces                                                                                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anti-slop`          | Vendored from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) at `c44ef22`, via effect-factory. See `tools/oxlint/anti-slop/UPSTREAM.md` | 18 generic rules: no `unknown` parameters or returns, no chained or widening type assertions, a `SAFETY:` comment on every assertion, no module mocking, no object parameters, readable spacing |
| `anti-slop-effect`   | Same repository                                                                                                                                      | No hand-written `_tag` errors, comparisons or objects (use `.make`); no service constructor imports; prefer `Effect.match`                                                                      |
| `aobot-standards`    | Copied from effect-factory's `factory-standards`                                                                                                     | Import Effect modules from `"effect"`, optional values as `Option`, narrow tagged errors by tag not `instanceof`, a `SAFETY:` comment on every `!`, JSDoc on every export                       |
| `aobot-architecture` | Rewritten from effect-factory's `factory-architecture` for our layout                                                                                | Workspace and feature boundaries, public entry points, a pure domain package. See below                                                                                                         |

Built-in rules on top: `typescript/no-explicit-any`, `oxc/no-accumulating-spread`, and `vite-plus/prefer-vite-plus-imports`.

### Feature-based architecture

Every app has the same three layers, as in effect-factory:

```
apps/<app>/src/
├── app/                   composition: main, layer wiring, routes. May import any feature's public.ts
├── features/<feature>/
│   ├── public.ts          the only file other features and app/ may import
│   └── …                  internals, private to the feature
└── shared/                generic helpers. May not import features or app/
```

`packages/domain` holds the schemas every app shares. Workspaces import each other only by package
name (`@aobot/domain`), never by relative path or deep path.

The allowed dependencies live in `tools/oxlint/aobot-architecture/policy.ts`. Register a feature there
before creating its directory. The server graph today:

| Feature                                        | May depend on                          |
| ---------------------------------------------- | -------------------------------------- |
| `bots`, `audit`, `policy`, `computers`, `auth` | nothing                                |
| `gateway`                                      | `bots`, `policy`, `audit`, `computers` |
| `agent`                                        | `bots`, `gateway`                      |
| `chat`                                         | `bots`, `agent`                        |
| `approvals`                                    | `gateway`                              |

Only `gateway` depends on `computers`, so "every action goes through the gateway" is enforced by the
graph itself, and a test checks that it stays that way.

| Rule            | Rejects                                                                                                                                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `boundaries`    | An undeclared feature or workspace dependency, a file outside `app/`, `features/<name>/` or `shared/`, an unregistered feature, `shared/` importing a feature, a feature importing `app/`, a relative import into another workspace |
| `public-api`    | Importing another feature's internals instead of its `public.ts`; `@aobot/x/deep/path` instead of `@aobot/x`                                                                                                                        |
| `domain-purity` | Node built-ins, React or Electron in `packages/domain`                                                                                                                                                                              |
| `context-leaf`  | A module that creates a React context and imports anything but `react` at runtime                                                                                                                                                   |

### Restricted properties

| Where                                             | Rejects                                      | Why                                                          |
| ------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------ |
| all workspaces, except `src/**/config.ts`         | `process.env`                                | Settings go through Effect `Config`                          |
| `apps/server`                                     | `console.*`                                  | Logs go through Effect's logger so they carry the `trace_id` |
| `packages/domain`, `features/policy`, `redact.ts` | `Date.now`, `Math.random`, `performance.now` | Decisions and redaction are pure and repeatable in tests     |

Tests, `testing/` folders, `e2e/` and `verify/` are exempt from these, as in effect-factory.

### The lint rules have tests

Custom rules are code, so they are tested. `tools/oxlint/aobot-architecture/architecture.test.ts` and
`tools/oxlint/aobot-standards/standards.test.ts` lint fixture files with `vp lint` and the real
config from `tools/oxlint/config.ts`, for both what must be rejected and what must pass. They also check that every
declared graph is acyclic and that only the gateway reaches computers.

## knip

Workspaces with explicit `entry` and `project` globs. The vendored anti-slop code is ignored. Unused
files, exports and dependencies fail `check`.

## Tests that keep docs honest

effect-factory has `feature-map.test.ts`, which fails when a key binding or command is missing from the
docs. aobot has the same kind:

- **Backlog test** (`tools/docs/backlog.test.ts`, live now): every ticket's front-matter decodes, its id
  matches its file name and epic folder, ids are unique, `depends_on` points at real tickets without
  cycles, and every `done` ticket has a `verify/scenarios/<id>.ts`.
- **Front-matter test** (`tools/docs/front-matter.test.ts`, live now): every page under `docs/` has the
  `title` and `description` the docs site needs.
- **Tool map test** (arrives with E1-1): every tool the gateway accepts appears in
  `docs/arc42/` with its audit row shape.

## Issue templates and agent instructions

`.github/ISSUE_TEMPLATE/` has `slice.yml`, `bug.yml` and `chore.yml` with blank issues off.
`CLAUDE.md` (with `AGENTS.md` as a symlink) lists the commands and rules.
