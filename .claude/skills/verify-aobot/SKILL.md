---
name: verify-aobot
description: Launch and drive the real aobot web app (chat with a Bot that has its own computer) in a real browser to prove a change works. Brings up the docker compose verify stack on a scripted mock model, drives the page with agent-browser, reads audit rows from SQLite and spans from Tempo, saves screenshots as evidence. Use before calling any aobot change done, when a ticket's `vp run verify` scenario does not exist yet, or when you need to poke at chat, browsing, shell, live screen or take-control by hand.
---

# verify-aobot

aobot is a React web app (`apps/web`) served by an Effect server (`apps/server`) that talks to a model and
starts a Docker container per Bot (`apps/computer`, "the computer"). The user touches one page: a chat
column plus a side panel showing the Bot's screen. Everything here runs against that page.

Two ways to prove something:

1. **A ticket's scripted demo:** `vp run verify <ticket-id>` (e.g. `E1-5`). Builds the stack, runs
   `verify/scenarios/<id>.ts`, tears down. This is the definition of done for a ticket. Use it when the
   scenario exists.
2. **Ad-hoc driving (this skill's helper):** keep the same stack up and drive it step by step. Use it to
   explore a new change, debug a failing scenario, or prove something no scenario covers yet. When you are
   done, write what you proved into a scenario if it belongs to a ticket.

Feature map: [`features/README.md`](features/README.md). Read the file for the feature you touch.

## Launch

From the repo root (needs Docker running and `agent-browser` on PATH):

```bash
.claude/skills/verify-aobot/scripts/stack.sh up
```

- Same compose project (`aobot-verify`), files (`docker-compose.yml` + `verify/compose.yml`) and ports as
  `vp run verify`. Builds the server, the mock model, the fixture and the `aobot-computer:dev` image.
  First build ≈ 3–6 min, rebuilds ≈ 30–60 s.
- **Ready** = it prints `ready: app http://localhost:3100 …` and `evidence: <dir>`. `--wait` blocks on the
  server's healthcheck, which fetches `/` — that only passes after migrations ran and the page is served.
  The SQLite file starts empty (volume removed on `down`), so every run starts from a fresh conversation.
- What is up:
  - App: http://localhost:3100 (server, model = `verify/mock-model.ts`)
  - Grafana: http://localhost:3400 (Tempo traces, anonymous Viewer)
  - Mock model control: http://localhost:4110 (`PUT /mock/script`, `GET /mock/requests`)
  - Fixture pages for the computer, only reachable from inside: `http://fixture:8080/link`, `/followed`,
    `/injection` (`verify/fixture.ts`)
- The computer container (`aobot-verify-computer`) is started by the server on the Bot's first computer
  action, not by `up`. First start ≈ 5–15 s.

Code changed after `up`? The images are stale. `down`, then `up` again.

## Isolation

- Beside the dev stack: yes. `docker compose up` uses project `aobot`, ports 3000/3300. This uses
  `aobot-verify`, 3100/3400/4110.
- Two verify stacks: **no.** Ports are fixed. `up` refuses if `aobot-verify` already runs or a port is
  taken. Do not work around that; someone else (or another agent) is driving it.
- **`vp run verify <id>` tears down this stack first** (`down --volumes`) and again at the end. Never run it
  while an ad-hoc session is live, and never run it while another agent's ad-hoc session is live.
- `vp run dev:acp` also binds 3100 (on the host). It cannot run with this stack.
- Browser: the helper uses agent-browser session `aobot-adhoc`; scenarios use `aobot-verify`. Always pass
  `--session aobot-adhoc` when driving by hand.

## Doctor

Read-only. Run it first, and whenever anything looks off:

```bash
.claude/skills/verify-aobot/scripts/stack.sh doctor
```

Checks: every service's state/health, `GET /` answers 200, port 3100 is owned by Docker (not a host
`dev:acp` server), the mock model answers, the server image's build time (compare to your last edit), and
whether the computer container runs. Ends `doctor: OK` or `doctor: NOT OK` (exit 1).

## Drive

Two halves: tell the mock model what to do next turn, then act on the page like a person.

### 1. Script the model

The mock model replays a `ModelScript`, one step per model call
(`apps/server/src/features/agent/testing/model-script.ts`). Without a script it loops
`"Hi there, nice to meet you!"`. Set the next turn's steps:

```bash
.claude/skills/verify-aobot/scripts/stack.sh script <<'JSON'
[
  { "_tag": "CallTools", "calls": [{ "name": "navigate", "params": { "url": "http://fixture:8080/link" } }] },
  { "_tag": "Say", "words": ["The", " page", " is", " open."] }
]
JSON
```

- Tools the model can call: `navigate {url}`, `snapshot {}`, `click {ref}`, `type {ref, text}`,
  `run {command}`, `read_file {path}`, `write_file {path, contents}`, `list_files {path}`. Refs are unknown until a page is read: `{"$refTo": {"role": "searchbox", "name": "Search Wikipedia"}}`
  in `params` is filled with the matching ref from the latest snapshot the server sent.
- A script that runs out mid-turn fails the turn. One `Say` at the end of every script.
- `stack.sh requests` prints every request the server sent the model since the last `script` — the proof of
  what the model was told (tool results, refusals, `<untrusted_data` envelopes).

### 2. Drive the page

Every browser command goes through `stack.sh ab …` (agent-browser in session `aobot-adhoc`). Do not put
`agent-browser --session …` in a shell variable: zsh does not split it.

```bash
S=.claude/skills/verify-aobot/scripts/stack.sh
$S ab open http://localhost:3100
$S ab wait --load networkidle
$S ab set media dark reduced-motion        # stops the panel's slide animation eating clicks
$S ab find placeholder "Message Assistant" fill "Open the link page and tell me its title."
$S ab press Enter
$S wait-answer 1 "The page is called Link." 90   # exact text of answer #1, 90 s limit
```

Stable handles (from `apps/web/src`):

| What          | Handle                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| Composer      | placeholder / aria-label `Message Assistant`                                                            |
| Send / Stop   | button aria-label `Send` / `Stop` (Stop only while a turn runs)                                         |
| Answers       | `.bubble--assistant .bubble__text`                                                                      |
| Tool card     | `.tool-call[data-tool="<name>"][data-status="running\|done\|failed"]`, result in `.tool-call__result`   |
| Screen panel  | `aside[aria-label="The Bot's screen"]` = `.live-screen`, `data-state="open\|folded"`                    |
| Folded rail   | button aria-label `Take control`                                                                        |
| Panel buttons | text `Take control`, `Hand back`, `Start the computer` (use `find role button click --name "<text>"`)   |
| Panel status  | `.live-screen__status` ("The Bot holds its computer.", "You have control. The Bot waits…")              |
| Live frame    | `img.live-screen__frame`, `data-control="person\|bot"`; a click on it clicks the computer               |
| Conversation  | URL query `?c=<id>`; reload keeps the conversation                                                      |
| Attach        | button aria-label `Attach a file`, `input[type="file"]` (`ab upload`), chips `.attachment[data-status]` |
| File chip     | `.tool-call[data-tool="write_file"] a.file-chip` (`ab download <sel> <path>`)                           |

Waiting: poll, do not sleep blindly. `wait-answer` polls for you; for anything else:

```bash
$S answers                                                   # every non-empty answer, oldest first
$S ab get count '.tool-call[data-tool="navigate"][data-status="done"]'
$S ab eval "document.querySelector('.live-screen')?.dataset.state"
```

Each word of a `Say` streams ~150 ms apart. A computer turn takes 5–20 s the first time.

For repeatable flows, reuse the TypeScript helpers in `verify/chat.ts` (`script`, `send`, `ask`,
`answers`, `doneCards`, `failedCards`, `cardResult`, `auditRows`, `modelRequests`), `verify/screen.ts`
(`panelState`, `panelText`, `frameColours`, `centreColour`) and `verify/tempo.ts` (`traceSpans`,
`ancestry`, `attribute`) by writing a scenario under `verify/scenarios/` — but note they use the browser
session `aobot-verify`, not `aobot-adhoc`.

## Evidence

Everything goes in the folder `up` printed: `.verify-evidence/<yyyymmdd-hhmmss>/` at the repo root
(gitignored). The helper writes to the newest folder; set `EVIDENCE=<dir>` to pick one.

```bash
S=.claude/skills/verify-aobot/scripts/stack.sh
$S shot 01-before-send          # screenshot → <dir>/01-before-send.png
$S snap 02-after-answer         # accessibility tree → <dir>/02-after-answer.snapshot.txt
$S audit --save                 # audit_rows from SQLite → <dir>/audit.json
$S requests --save              # what the model was sent → <dir>/model-requests.json
$S trace <trace_id> --save      # span names (+ events) of that trace → <dir>/trace-<id>.json
```

`down` also saves `server.log` there.

Proof standards:

- Drive the real page as a person would: composer, buttons, clicks on the frame. Never call RPCs or write
  to SQLite to make a step happen. `verify/rpc-smoke.ts` is a probe, not proof.
- The mock model is the one allowed stand-in: it sits behind the same OpenAI-compatible boundary as a real
  model. Everything after it (gateway, computer, audit, traces) is real.
- Capture the action and the result: a screenshot before and after, not only the end screen.
- Check side effects next to what the page shows: `audit` rows (action · decision in order), `requests`
  (what the model was told), `trace <trace_id>` with the `trace_id` from an audit row (one `Chat.turn` per
  turn, `Gateway.act` per tool call; Tempo needs 5–30 s to have it, retry on 404), files in the computer
  (`docker exec aobot-verify-computer ls /workspace`).
- Never paste what the Bot typed into a page, or secrets, into evidence notes. Commands in `audit.json` are
  the allowed exception (see `CLAUDE.md`).

## Cleanup

```bash
.claude/skills/verify-aobot/scripts/stack.sh down
```

Saves `server.log` into the evidence folder, closes the `aobot-adhoc` browser session, removes the
`aobot-verify-computer` container the server started, then `compose down --volumes` on project
`aobot-verify` only. It never touches the dev stack (`aobot`) or other agent-browser sessions.
`.verify-evidence/` survives; delete old folders by hand when you no longer need them.

After a failed or aborted run, still run `down`. If `down` complains a network is in use, a computer is
left behind: `docker ps --filter name=aobot-verify` and remove only those.

## Helpers

`.claude/skills/verify-aobot/scripts/stack.sh <command>`:

| Command                       | Does                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| `up`                          | refuses if already running or a port is taken; builds and starts; prints URLs + evidence dir |
| `doctor`                      | read-only health check, exit 1 if not worth driving                                          |
| `script [file\|-]`            | `PUT /mock/script` with a ModelScript JSON                                                   |
| `requests [--save]`           | what the server sent the model since the last `script`                                       |
| `audit [--save]`              | audit rows as JSON, optionally saved to evidence                                             |
| `trace <id> [--save]`         | span names and events of one trace from Tempo                                                |
| `ab <agent-browser args…>`    | any agent-browser command in session `aobot-adhoc`                                           |
| `answers`                     | every non-empty answer on the page, as JSON                                                  |
| `wait-answer <n> <text> [s]`  | wait until answer n reads exactly text; exit 1 on timeout                                    |
| `shot <name>` / `snap <name>` | screenshot / accessibility snapshot of session `aobot-adhoc` into evidence                   |
| `logs [n]`                    | last n lines of the server log                                                               |
| `down`                        | save server log, close browser, remove computer, compose down                                |

## Not covered here

- `vp run dev:acp` (real Claude Code / Codex subscription over ACP, host server on 3100): drive the same
  page the same way, but there is no mock model, no `script`, and no `audit` helper (the DB is a host
  file at `DATABASE_PATH`). `vp run verify E0-5` is its scripted proof.
- `vp run test:contract*` and `vp run check` are test suites, not user paths.
