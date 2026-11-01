# aobot verification map

The maintained source for proving aobot's user-facing behavior. Read this index, then the feature file
you touch. Every recipe drives the real page at http://localhost:3100 through
`.claude/skills/verify-aobot/scripts/stack.sh` (shortened to `$S` below:
`S=.claude/skills/verify-aobot/scripts/stack.sh`).

## Baseline preconditions

- `$S up` printed `ready:` and an evidence folder. `$S doctor` ends `doctor: OK`.
- The SQLite file is fresh (each `up` starts from an empty volume). One Bot exists: `Assistant`.
- The page is open in session `aobot-adhoc`: `$S ab open http://localhost:3100`, `$S ab wait --load networkidle`,
  `$S ab set media dark reduced-motion`.
- Before every turn, `$S script` the model. An unscripted turn answers `Hi there, nice to meet you!`.
- Never drive a stack this run did not start, and never run `vp run verify` beside it (it tears it down).

## Driving conventions

- Act through the composer, buttons and the live frame, as a person. Never call `/rpc` or touch SQLite to
  make a step happen.
- Prefer aria-labels and button names (`find role button click --name "Hand back"`), then the `data-*`
  attributes listed in SKILL.md. No coordinates except clicks on the live frame.
- Each new turn's answer is the next index: the first answer is `wait-answer 1`, the second `wait-answer 2`.
- A scripted turn uses up its steps in order; end every script with a `Say`.

## Proof and skip reporting

- A screenshot before the action and one after (`$S shot`), plus `$S snap` of the result.
- Side effects next to the page: `$S audit --save` (action · decision in order), `$S requests --save`
  (what the model was told), `$S trace <trace_id> --save` for the turn's spans.
- Record the feature file and sub-feature ID next to each artifact name (e.g. `browse-navigate-02.png`).
- An entry point you could not reach is reported as not verified, with the command and the missing
  precondition. Never report it verified through a different path.

## Feature entry contract

Each file: H1 title, one paragraph of user-visible behavior, then exactly `Sub-features`,
`How to get to it (user POV)`, `Driving it with stack.sh`, `Gotchas`.

## Features

- [Chat](./chat.md): send, streamed answer, reload keeps the conversation, stop a running turn. Ticket E0-1.
- [Browse](./browse.md): the Bot opens, reads, clicks and types on web pages; injected instructions stay data. E1-1, E1-2.
- [Shell](./shell.md): the Bot runs bash in its own `/workspace`; the server stays out of reach. E1-3.
- [Live screen](./live-screen.md): the side panel shows the Bot's browser while it works, folds after. E1-4.
- [Take control](./take-control.md): a person takes the computer, clicks on it, hands back; the Bot is refused meanwhile. E1-5.
- [Files](./files.md): a person uploads into the Bot's workspace and downloads what it saved; the Bot's file tools stay inside it. E1-6.

Cross-cutting: every turn is one `Chat.turn` trace (E0-2). Check it with `$S trace` on any feature's audit
row `trace_id`.
