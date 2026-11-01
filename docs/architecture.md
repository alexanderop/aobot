# Architecture

## What aobot is

A chatbot answers. A coworker acts: it opens pages, fills in forms, runs scripts. aobot gives each Bot
three things:

|                | What it means                                                              | Where it lives                  |
| -------------- | -------------------------------------------------------------------------- | ------------------------------- |
| **A role**     | A name, instructions, and the tools it is granted                          | `bots.yaml`, later the admin UI |
| **A computer** | Its own Chromium, bash and `/workspace`, in a container                    | `apps/computer`                 |
| **Guardrails** | Grants, rules that fail closed, an audit trail, a person who can take over | `apps/server` gateway           |

## The five parts

```
 Desktop app / web page ──► Server ──► Agent runtime (`api`: effect/ai · `acp`: your own CLI)
                              ▲              │ tool call
                              │              ▼
                              └──── Gateway: granted? → rules? → audit row → forward
                                                                   │
                                                                   ▼
                                                 Computer (container: Chromium, bash, /workspace)
```

| Part                | Its one job                                                            | Built with                   |
| ------------------- | ---------------------------------------------------------------------- | ---------------------------- |
| `apps/web`          | Show the conversation and the live screen, let a person take the mouse | React + `@effect/atom-react` |
| `apps/desktop`      | Wrap `apps/web`, keep the sign-in token safe, send notifications       | Electron                     |
| `apps/server`       | Know Bots and people, run agent turns, stream answers                  | Effect on Node               |
| Gateway (in server) | Decide if a tool call may happen, record it, then forward it           | Effect service + SQLite      |
| `apps/computer`     | Actually do it: browse, click, type, run commands                      | Node + Playwright in Docker  |
| `packages/domain`   | Schemas shared by all of the above: Bot, ToolCall, AuditRow, ChatEvent | Effect Schema                |

### Inside each app: features

Each app is split by feature, not by technical layer: `src/app` wires things together,
`src/features/<feature>` holds one capability end to end with `public.ts` as its only entry point, and
`src/shared` holds generic helpers. Which feature may use which is declared in
`tools/oxlint/aobot-architecture/policy.ts` and enforced by oxlint. See
[quality-gates.md § Feature-based architecture](quality-gates.md#feature-based-architecture).

The agent never talks to a computer directly. It can only ask, and the gateway answers. The feature graph
enforces this: only the `gateway` feature may depend on `computers`.

## Agent runtimes

The think-act loop is a provider, like a computer. One `AgentRuntime` service, two implementations,
chosen by `AGENT_RUNTIME`:

| Runtime | Where              | Model and billing                                                                 | How tools reach the gateway                                                                                    |
| ------- | ------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `api`   | Cloud, and locally | Any provider with an API key: Anthropic, OpenAI, OpenAI-compatible, OpenRouter    | `effect/ai` `LanguageModel` with our own loop. The `Toolkit` handlers _are_ the gateway; there is nothing else |
| `acp`   | Laptop only        | The person's own subscription: Claude Code, Codex or OpenCode, spoken to over ACP | Our tools offered as one MCP server in `session/new`. Built-in tools are switched off                          |

Whatever the runtime, the only tools a Bot has are gateway tools. For `acp` that is not the default, so it is
enforced three ways:

1. The CLI is started with its own tools switched off and only the gateway MCP server offered.
2. Every `session/request_permission` and every client-side `fs/*` or `terminal/*` request is refused unless
   it names a gateway tool, and the refusal is an audit row.
3. The agent runtime contract suite asks each CLI, through the scripted model, to run a shell command and
   read a file outside the gateway. Both must fail. A CLI that fails the suite is not supported.

`acp` runs on one person's subscription, so it is refused at start-up unless single-user mode is on and the
server listens on loopback. A subscription is never shared between people and never runs in the cloud.

## Two computers: the cloud one and your Mac

A Bot always has its cloud computer. While the desktop app is open and signed in, it can also use the
person's own Mac. Every computer tool takes a `computer` argument, `cloud` or `mac`, and rules see it as
`computer.kind`.

|                   | Cloud computer                               | Your Mac                                                                                           |
| ----------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Exists            | Always; started on demand, stopped when idle | Only while the desktop app is open and signed in as its owner                                      |
| How it is reached | The server calls it: "a URL and a token"     | The desktop app connects out to the server and pulls work; the server never dials a laptop         |
| Files             | `/workspace`                                 | Only folders the person picked in the macOS folder dialog, one grant per Bot, revocable            |
| Shell             | `bash` in the container                      | Per command, a native "Allow?" dialog by default, run in a sandbox without network                 |
| Browser           | The Bot's Chromium                           | The person's installed Chrome with a separate aobot profile, never their own profile               |
| Who may use it    | The Bots of the person it belongs to         | The Bots of the signed-in owner only, never another person's, never a routine with nobody watching |

The gateway is still the only door: grant, rules, audit row, then forward. The Mac adds a second check on
the Mac itself, the native dialog, because a rule written on the server cannot see what is on the
person's disk. When the app is closed, a `mac` call fails with "your Mac is not connected" rather than
waiting.

## Life of one request

1. A person sends a message with the Bot they picked.
2. The server starts an agent turn with the Bot's instructions and its granted tools.
3. The agent asks for a tool, for example `navigate`.
4. The gateway checks the grant, then the rules, and writes one audit row either way.
5. Only on "yes", the gateway asks the person's computer to act, and never when its row could not be
   written. Every `allow` row then gets exactly one outcome row, `succeeded`, `failed` or `unknown`, so
   "allowed" never reads as "done". `unknown` means the server lost track, by a timeout or a restart; such a
   call is never run again, and a row left without an outcome by a crash is marked `unknown` at start-up.
6. The computer returns the page as text: the accessibility tree, with a ref per element.
7. The gateway wraps it as untrusted data (decision 10) before the agent sees it.
8. The agent reads it and decides the next step. Every step goes through the same door.
9. The answer streams back to the page, with each tool call shown between the text.

## Watching the screen

While a turn the page started is running and has called a tool, or while the person holds the Bot's
computer, the page opens the Bot's screen as a side panel and watches it. Folded, the panel is a rail
with one button, Take control. A page that joins a running turn keeps the panel folded, because it cannot see when
that turn ends. The screen goes through the gateway feature but not its audited tools: watching asks the
computer to do nothing, so it is not audited, and it never starts a computer.

1. The computer runs one `Page.startScreencast` on the Bot's page while anyone watches, and moves it to the
   new page when the browser replaces a closed one. It serves the frames on `GET /stream`, a WebSocket
   behind the same bearer token and the same refusal of callers on the computer itself as `/act`. A viewer
   that reads slowly skips frames.
2. The server holds one connection to `/stream`, shared by every viewer, dialled only once a computer it
   started answers. When the computer is replaced it dials the new one with its new token, and it hangs up
   a while after the last viewer leaves.
3. The page asks `Screen.watch` on its own socket to `/rpc` and draws the latest frame as an `<img>`.
   `Screen.watch` sends a `Screen`: a `Frame`, the base64 JPEG the computer sent, or `Blank` while no
   computer runs or answers, and before a new one paints. A viewer is first sent the screen as it is now.

The page never learns the computer's address or token. A frame shows whatever the Bot typed, so it never
goes into a log, a span or an audit row.

## Taking control

A person takes the mouse when their Bot reaches a login or a CAPTCHA, clicks on the live screen
themselves, and hands it back. While the person holds the computer, the panel stays open, and every Bot
action is refused. `ComputerControl` does it, from the same layer as `Gateway`, so a person's take and the
Bot's actions meet at one door per Bot.

1. Each Bot has one door in the gateway, and every Bot action goes through it before anything else, in
   `Gateway.act`, whatever its tool. The door is `Open` while the Bot holds its computer, `Closing` while a
   take waits, and `Held` while the person holds it. Only an open door lets an action in. A Bot's
   commands wait for each other outside the door, so a command whose turn comes while the person holds
   the computer is refused, and a take never waits for one.
2. `Control.take` writes `control_taken · allow`, closes the door, stores a row for the Bot in
   `bot_control`, then waits for the actions the door already let in to finish. The page shows `Taking`
   meanwhile. Once the person holds the computer, the take starts it if none runs, and answers. A
   computer that does not start leaves the person holding it, and the page says why. Taking again while
   holding it changes nothing but starts the computer again.
3. `bot_control` is read at start-up, so a restart, even one in the middle of a take, leaves the person in
   control. No computer runs then: the panel says the computer is not showing a page and offers to start
   it, which takes control again.
4. While the door is not open, a Bot call is a `deny` row with `{ reason: "a person has control" }`, the
   computer never hears of it, and the model reads:

   > navigate did not run: a person has control of your computer. Wait until they hand it back, then take
   > a snapshot.

5. `Control.click` sends a click to the computer's `POST /input` as fractions of the screen, only while
   the person holds it and only to a computer already running, within 15 seconds. The page reads the
   fractions off the frame it draws; only the computer knows its viewport, so only the computer turns
   them into pixels. The computer clicks only once the browser's last action has settled, even one whose
   caller stopped waiting for it, so a Bot action from a stopped turn never lands beside the person's
   click. A click the page holds up past 5 seconds fails, and the browser is free for the next action.
   A person's clicks are not audited: the rows around them say who held the computer.
6. `Control.handBack` writes `control_released · allow`, and in one transaction deletes the Bot's
   `bot_control` row, forgets its latest snapshot and writes `succeeded`. The Bot's old refs are then
   refused like any ref without a snapshot, so it reads the page again before it acts on an element.

`/rpc` refuses a request with 403, before any RPC, unless the host it was sent to, its `Host`, is
`localhost`, `127.0.0.1`, `[::1]` or the server's `PUBLIC_HOST`, and a page's `Origin`, when it sends one,
names that same host. A browser lets any page open a socket to any address, so without the `Origin` check
any site the person visits could take control. Without the `Host` check, a site that points its own name
at this machine (DNS rebinding) could, and it needs no `Origin` for it: a browser sends none with a
same-origin `GET`. A client that is no page sends no `Origin` and is let through to this machine's names,
unless a browser's `Sec-Fetch-Site` says another site sent it, as it does for a link or an `<img>` that
carries no `Origin`. The `/files` routes below are guarded the same way.

`control_taken` and `control_released` are `allow` rows with an outcome, so a crash in the middle of
either is swept to `unknown` at start-up like any other call. Their spans, `ComputerControl.take` and
`ComputerControl.handBack`, carry the events `control.door_closed` (with `control.in_flight`),
`control.taken` and `control.released`; a refused call adds `control.refused` to its `Gateway.act` span.

## Files in and out of the workspace

A person gives the Bot a file to work on and downloads the file it made, without copying text through the
chat. Both are the person's own calls, not the Bot's, so they do not go through the Bot's door: a person
holding the computer can still move files. `FileTransfers` does them, from the same layer as `Gateway`.

1. `＋` in the composer uploads a picked file at once with `PUT /files?path=<name>`. The server
   needs its `Content-Length`: past 100 MiB it is `file.uploaded · deny` with `{ reason: "too large" }`
   and a 413 before a byte of the body is read. Otherwise `file.uploaded · allow` with
   `{ path, name, extension, bytes }`, the computer is started if none runs, and the body streams through
   to the computer's own `PUT /files?path=`, never held whole. The computer writes it to a file of its own
   in the same folder and renames it into place only once all of it arrived, counting as it goes: past 100
   MiB it stops with 413 and keeps nothing. The outcome row says `succeeded` with the bytes saved, or
   `failed` with `{ reason: "the upload stopped partway" }` when the person's body broke off, since the
   computer kept none of it. Taking the chip out while it uploads stops the upload.
2. The message the person sends then ends with a line naming every file that arrived, such as
   `I put expenses.csv in your workspace.`, so the model knows it is there. Those chips clear only once
   the message went, so a message the conversation turned away keeps them.
3. A `write_file` card that is done holds a file chip, a link to `GET /files?path=`. That is
   `file.downloaded · allow` with `{ path, name, extension }`, and the computer's `GET /files?path=` streams
   the exact bytes back with their length, through the server to the browser. A download never starts a
   computer. Its outcome row is written when the person's request ends: `succeeded` with the size when
   the last byte went out, and `unknown` when the person went away before it or the body was never sent.
   The computer's answer is dropped then too, read to its end or not. A `HEAD /files` is answered 405
   without asking the computer, and writes no row.

A path that is absolute or goes up with `..` is a `deny` row with `{ reason: "outside workspace" }`, and
the computer never hears of it. The rows never hold what a file holds. Both spans, `FileTransfers.upload`
and `FileTransfers.download`, record `gateway.file_bytes`; the download's lasts until the person's request
ends. The HTTP client's spans of the server's requests to the computer's `/files` record the path as
`REDACTED`.

## Gateway tools

Every tool a Bot has, in either runtime. The tool map test (`apps/server/src/features/gateway/tool-map.test.ts`)
fails when a tool in `botToolkit` is missing here or a row here names no tool. Each call writes the `allow`
row first, then one outcome row linked to it by `outcome_of`. Both carry the turn's `trace_id`; the outcome row
copies the action, and its `detail` says why for `failed` and `unknown`.

| Tool         | Parameters         | Computer action                                               | Audit rows                                                                                                                                                          |
| ------------ | ------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `navigate`   | `url`              | `POST /act {"action":"navigate","url"}`                       | `navigate · allow` with `{ url }`, then `succeeded`, `failed` or `unknown`                                                                                          |
| `snapshot`   | none               | `POST /act {"action":"snapshot"}`                             | `snapshot · allow` with `{}`, then `succeeded`, `failed` or `unknown`                                                                                               |
| `click`      | `ref`              | `POST /act {"action":"click","target":{ref,role,name}}`       | `click · allow` with `{ ref, role, name }`, then `succeeded`, `failed` or `unknown`; `click · deny` with `{ ref, reason }`                                          |
| `type`       | `ref`, `text`      | `POST /act {"action":"type","target":{ref,role,name},"text"}` | `type · allow` with `{ ref, role, name, text: "[N chars]" }`, then `succeeded`, `failed` or `unknown`; `type · deny` with `{ ref, reason }`                         |
| `run`        | `command`          | `POST /act {"action":"run","command"}`                        | `run · allow` with `{ command }` (capped at 2,000 characters), then `succeeded`, `failed` or `unknown`                                                              |
| `read_file`  | `path`             | `POST /act {"action":"read_file","path"}`                     | `read_file · allow` with `{ path, name, extension }`, then `succeeded`, `failed` or `unknown`; `read_file · deny` with `{ path, name, extension, reason }`          |
| `write_file` | `path`, `contents` | `POST /act {"action":"write_file","path","contents"}`         | `write_file · allow` with `{ path, name, extension, bytes }`, then `succeeded`, `failed` or `unknown`; `write_file · deny` with `{ path, name, extension, reason }` |
| `list_files` | `path`             | `POST /act {"action":"list_files","path"}`                    | `list_files · allow` with `{ path, name, extension }`, then `succeeded`, `failed` or `unknown`; `list_files · deny` with `{ path, name, extension, reason }`        |

While a person holds the Bot's computer, every tool is refused before its ref is resolved: `<tool> · deny`
with `{ reason: "a person has control" }` (see [Taking control](#taking-control)).

Every browser action answers with the page read afresh: its URL, title and snapshot, capped at 12,000
characters. `type` replaces what the field holds and never presses Enter.

`run` answers how the command ended and the last 8,000 characters of each of stdout and stderr, each with
a note when its start was dropped. It ended `Exited` with bash's exit code, `Signalled` when a signal the
computer did not send ended bash (`kill -TERM $$`, a crash, the out-of-memory killer), or `TimedOut` when
it was still running after 30 seconds. A command that exits non-zero still `succeeded`: the computer ran
it, and the model reads how it ended. Once bash ends, the computer kills the command's process group, so
a background job such as `sleep 600 &` neither holds the answer until the time limit nor outlives it.
After a non-zero exit that happens at once. After exit 0 or a signal, the output first gets half a second
more, and when something still holds it open then, the model reads that the computer stopped what the
command left running. The time limit counts only until bash ends. A timeout and a Stop kill the group the
same way. A Bot's commands wait for each other in the gateway, so each one's time limit starts when the
one before is done.
The `Gateway.act` span records `gateway.command_end` (`exited`, `signalled` or `timed_out`) with
`gateway.exit_code` or `gateway.signal`; the command is in the audit row, never in a span or a log.

`read_file`, `write_file` and `list_files` name a file by its path inside `/workspace`, such as
`reports/august.csv`; the audit row records that path with its `name` and `extension`, the three that
rules see as `file.path`, `file.name` and `file.extension`. The path is a `WorkspacePath` from the domain,
on the tools, on `/act` and on both `/files` routes: `""` is read as `.`, the workspace itself, and nothing
is trimmed, so the gateway and the computer judge the very same name, and `a.txt ` is a file of its own.
A path is judged as the computer, which runs Linux, reads it: only a leading `/` makes it absolute and
only `/` separates, so `c:notes.txt` and `a\b.txt` are each one file's name. A path that is absolute,
`/workspace/notes.txt` included, or that goes up with `..` is denied before anything else, the computer
never hears of it, and the model reads:

> read_file did not run: /etc/passwd is outside your workspace. Name a file by its path inside /workspace,
> such as notes.txt, with no leading / and no "..".

The computer confines every path again on its own, because only it can see where a link leads: resolved on
disk, with every link followed as the kernel follows it, the file must still be inside `/workspace`,
compared as a relative path so `/workspace-evil` is not inside it. Node's own `realpath`, which `FileSystem`
uses, reads `..` after a link as text and would put `sub/..` back inside when `sub` leads out, so the
workspace asks the kernel instead. A write also follows a link already at its name, dangling or not, each
hop read from the folder it really is in. A link that points back inside keeps working. A link that leads
out is refused there, an `allow` row followed by `failed`.

`read_file` answers the first 16,000 bytes as UTF-8 text with the file's size, wrapped as untrusted
`file contents`. `write_file` saves at most 1 MB, writing a file of its own beside the target, under a short
name of its own so the longest name still fits, and renaming it into place, so a failed write leaves what
was there. `list_files` answers at most 500 files and folders, every level down, in name order, and does
not follow links. A folder it cannot open, or a file it cannot size, is listed as could not be read, and
the rest of the listing still comes back. The `Gateway.act` span records
`gateway.file_bytes` for a read or a write and `gateway.file_entries` for a listing; never a path or what a
file holds.

### Refs

A ref such as `e12` names one element of the latest snapshot the Bot was shown. The gateway stores that
snapshot per Bot in the database (`bot_snapshots`), replacing it after every action that answered, so any
replica resolves a ref the same way. Before any rule runs, `click` and `type` resolve their ref to the
element's role and name. A ref that is not in the stored snapshot is a `deny` row, the computer never
hears of it, and the model reads:

> click did not run: e12 is not a ref in your latest snapshot. Take a snapshot and use a ref from it.

The computer sends the resolved element, not just its ref, and reads the page afresh before acting. When
the element at that ref is gone or no longer has that role and name (the page changed, or a navigation
started Playwright's ref counter again), it refuses with:

> The page changed since your latest snapshot, so e12 is not the button it was. Take a snapshot again and
> use a ref from it.

A tool result reaches the model through one seam: `markUntrusted()`, a 20,000-character cap with a visible
`[truncated: N characters]` note, and a per-tool timeout. A failed call is a result the model reads, not a
dead turn.

## Decisions

| #   | Decision                                                                                              | Why                                                                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **No CopilotKit Intelligence.** Threads, messages and audit live in our own database (SQLite for now) | No external licence, no data outside our account                                                                                                                                                                                                                        |
| 2   | **The think-act loop is a provider**: `api` (effect/ai) or `acp` (your own CLI)                       | Any model in the cloud, your own subscription on a laptop, and in both the gateway is the only way to act. Not the Claude Agent SDK: its built-in tools run inside the server, beside the database file                                                                 |
| 3   | **Effect v4** on the server                                                                           | Typed errors make every gateway path visible, layers make providers swappable, `Effect.fn` gives tracing for free                                                                                                                                                       |
| 4   | **Web first, Electron as a wrapper**                                                                  | The agents run in the cloud, so the desktop app adds safe token storage and notifications, not core logic                                                                                                                                                               |
| 5   | **The page as text, not screenshots**                                                                 | `ariaSnapshot({ mode: "ai" })` with refs is cheap and needs no vision model. Snapshots are capped at 12,000 characters                                                                                                                                                  |
| 6   | **A computer is only ever "a URL and a token"**, or for a Mac, a connection the desktop app opened    | The server never uses `docker exec` or shared files, so where a computer runs can change freely. A laptop is behind NAT, so it dials out                                                                                                                                |
| 7   | **Fail closed**                                                                                       | A missing rule permits nothing, a crashing rule denies, a missing grant is refused before any rule runs                                                                                                                                                                 |
| 8   | **Never log what a Bot typed**                                                                        | The audit row keeps `"[14 chars]"`, not the value. It may be a password. A `run` command is the exception: its audit row keeps it as written, capped at 2,000 characters, because the command is what the row is for. Finding secrets inside commands is E2-3           |
| 9   | **OpenTelemetry from day one**                                                                        | One trace per chat turn, with the `trace_id` stored on every audit row                                                                                                                                                                                                  |
| 10  | **Outside content is untrusted data**                                                                 | Pages, command output and files reach the model inside one envelope that says they carry no authority. A page can say "ignore your instructions"; the envelope is what tells the model that is not its person speaking. A closing tag inside the content is neutralised |
| 11  | **Every audit row names its initiator**                                                               | `initiator_kind` is `person` or `deployment` now, `routine` and `handoff` later. `actor.id` says on whose authority; only this says whether anybody was watching                                                                                                        |
| 12  | **AG-UI events over Effect RPC, read through atoms**                                                  | One `ChatEvent` Schema in `packages/domain` with AG-UI's event names and fields, streamed by an Effect RPC and decoded on both sides. The web reads it through `effect/reactivity` atoms in a few hooks, shaped like CopilotKit's. No CopilotKit dependency             |

## The web app

React with `@effect/atom-react`. State lives in atoms from `effect/reactivity`; components read them
through a few hooks. The hooks copy the _shape_ of CopilotKit's
(`~/Projects/opensource/CopilotKit/packages/react-core/src/v2/hooks/`), not their mechanics: no Bot
tool ever runs in the page, so nothing depends on a tab being open.

```ts
// packages/domain: one schema, encoded by the server and decoded by the web
export class ChatRpcs extends RpcGroup.make(
  Rpc.make("Chat.send", { payload: SendMessage, success: ChatEvent, stream: true }),
  Rpc.make("Chat.stop", { payload: ConversationRef }),
) {}

// apps/web: the RPC client as an atom service, one conversation atom per id
class ChatClient extends AtomRpc.Service<ChatClient>()("ChatClient", { group: ChatRpcs, protocol }) {}
const conversation = Atom.family((id: ConversationId) => /* fold ChatEvents into one ordered transcript and a status */)
```

| Hook                       | Shaped like CopilotKit's             | What it gives a component                                                                                                                     | From |
| -------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `useConversation(id)`      | `useAgent`                           | `transcript` (messages and tool calls in order), `isRunning`, `usesComputer`, `send`, `stop`                                                  | E0-1 |
| `useToolCallRenderer()`    | `useRenderTool`, `useRenderToolCall` | A registry from tool name to a component that draws one tool call in each of its states                                                       | E1-1 |
| `useLiveScreen()`          | (none)                               | The latest screen frame, none while the screen is blank                                                                                       | E1-4 |
| `useControl()`             | (none)                               | Who holds the Bot's computer, why the last take, click or hand back failed, `takeControl`, `handBack`, `click`                                | E1-5 |
| `useAttachments(id, send)` | (none)                               | The files picked in the conversation's composer and how each upload went, `attach`, `dismiss`, and `send`, which names the files that arrived | E1-6 |

Not copied: `useFrontendTool` (it runs a Bot's tool in the open tab, which breaks routines, the Mac and
closed tabs) and CopilotKit's provider. The wire format stays AG-UI, so a CopilotKit or other AG-UI client
could still connect through a thin adapter later.

## Local now, AWS later

Two switches decide where things run. Code never checks which one is active.

| Switch                           | Local (now)                                                       | AWS (later)                                                      |
| -------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| `AGENT_RUNTIME`                  | `acp` on your own subscription, or `api` with a key               | `api` only                                                       |
| `COMPUTER_PROVIDER`              | `docker`: one container per person, a named volume for its logins | `ecs` (RunTask in a private subnet), later `k8s` (agent-sandbox) |
| `OTEL_EXPORTER_OTLP_ENDPOINT`    | the `grafana/otel-lgtm` container                                 | the AWS OpenTelemetry collector (ADOT) or Grafana Cloud          |
| `DATABASE_PATH` / `DATABASE_URL` | a SQLite file on a Compose volume (`DATABASE_PATH`)               | RDS Postgres with pgvector (`DATABASE_URL`)                      |
| Secrets                          | `.env` through Effect `Config`                                    | AWS Secrets Manager                                              |
| Model                            | Whatever your CLI uses, or any `effect/ai` provider with a key    | Any `effect/ai` provider; Bedrock is decided in E5-1             |

Rules that keep the move cheap:

1. SQLite locally, Postgres on AWS. aobot is a learning project and a proof of concept with one server process, so one file beats a database container. Moving to the cloud means switching to Postgres then (E5-1), and the in-memory one-run-per-conversation guard becomes a shared lock the day there is a second replica. Keep SQL inside the feature stores so that switch stays in one place.
2. Settings and secrets only through Effect `Config`, never `process.env` in application code.
3. Computers never publish ports. Only the server's network can reach them.
4. The images Compose runs are the images AWS runs.
5. Every computer provider passes the same contract test suite before it is used. See [testing.md](testing.md).

The `Computers` service has OpenBot's four supervisor operations, plus `screen`. There is one shared
computer until E3-3 adds a `person` argument:

```ts
export interface Interface {
  readonly ensure: Effect.Effect<Computer, ComputerUnavailable>; // start if needed, wait until healthy
  readonly running: Effect.Effect<Computer, ComputerUnavailable>; // the one running, never starting one
  readonly stop: Effect.Effect<void, ComputerUnavailable>;
  readonly reset: Effect.Effect<void, ComputerUnavailable>;
  readonly list: Effect.Effect<ReadonlyArray<ComputerStatus>, ComputerUnavailable>;
  // The running computer's screen for any number of viewers. Never starts a computer, never fails.
  readonly screen: Stream.Stream<Screen>;
}

// A running computer: a URL and a token, whichever provider started it. `browse`, `run` and `files` are
// `POST /act`, and each reads only the answer its action promises, so a page answering a command is
// ComputerLost. `download` and `upload` are `GET` and `PUT /files`, a file's bytes as they are. `input` is
// `POST /input`, what a person in control did on the screen.
export interface Computer {
  readonly browse: (
    action: PageAction,
  ) => Effect.Effect<PageRead, ComputerActFailed | ComputerLost>;
  readonly run: (
    command: RunCommand,
  ) => Effect.Effect<CommandRan, ComputerActFailed | ComputerLost>;
  readonly files: (
    action: FileAction,
  ) => Effect.Effect<FileAnswer, ComputerActFailed | ComputerLost>;
  readonly download: (
    path: string,
  ) => Effect.Effect<FileDownload, ComputerActFailed | ComputerLost>;
  // A body that fails partway fails the upload with its own error.
  readonly upload: <E>(
    path: string,
    body: Stream.Stream<Uint8Array, E>,
  ) => Effect.Effect<FileSaved, ComputerActFailed | ComputerLost | E>;
  readonly input: (input: PersonInput) => Effect.Effect<void, ComputerActFailed | ComputerLost>;
}
```

## Security notes

A Bot has a shell and a browser. The browser reaches only what the egress filter allows. A command
reaches the same as long as it uses the proxy settings it is given, and whatever the computer's network
reaches when it does not, until network limits (E5-3). These hold locally as much as on AWS:

- **The database is not on the computers.** The SQLite file lives on a volume only the server mounts, so a
  Bot's shell has no file to read or write.
- **The browser refuses private and metadata addresses.** `169.254.0.0/16`, `fe80::/10`, loopback and
  private ranges are refused, so a Bot cannot browse to internal services. `COMPUTER_ALLOW_PRIVATE_HOSTS`
  exists for local fixtures and stops the server from starting in production.
- **Single-user mode never faces the internet.** With it on, every request is one administrator. The
  server refuses to start if its public URL resolves to a public address, and warns on a private one.
- **A command does not inherit the computer's environment.** It gets PATH, the locale, `HOME=/workspace`
  and proxy variables naming the computer's egress filter, from an allow-list, so `env` never prints
  `COMPUTER_TOKEN` or a secret added later. A command that honours those variables is held to the
  browser's destinations, and private hosts stay refused to it even where `COMPUTER_ALLOW_PRIVATE_HOSTS`
  opens them to the browser. A command can still unset them and connect directly; network limits close
  that (E5-3). `bash -c`, never a login shell, so a `.bash_profile` the Bot wrote cannot run first.
- **A Bot's files stay in `/workspace`.** The gateway denies a path that is absolute or goes up with `..`,
  and the computer refuses one that leads out once links are followed. A command can still read anything
  its user can, which is the shell's reach, not the file tools'.
- **`/act`, `/files`, `/input` and `/stream` refuse callers on the computer itself.** A request from a loopback address or from
  one of the computer's own addresses gets 403 before its token is read, so a command that finds the token
  cannot drive the browser around the gateway or watch it through `/stream`. What remains: commands run as
  the same user as the computer's own process, so they can read its environment and memory
  (`/proc/<pid>/environ`, and likely `ptrace`), and `setsid` lets a command leave its process group and
  outlive its time limit or a Stop. The same user also reaches the browser two more ways. Xvfb's socket in
  `/tmp/.X11-unix` asks for no X authority, so a command can watch the screen and send it keys and clicks.
  The Chromium profile in `/tmp/aobot-browser-*` holds the cookies of every site the Bot is signed in to.
  Running commands as a separate user, or in a sidecar, closes all of these (see `docs/backlog/later.md`).
- **Grafana cannot relay a command to `/act`.** `grafana/otel-lgtm` shares the computers network, because
  the computer exports its spans there, so its requests come from an address `/act` accepts. Its image
  makes every visitor Admin, and Admin can add a data source pointing at the computer and send requests
  through it. Compose makes visitors Viewers, who read traces and cannot add data sources, and turns off
  basic auth and the login form, so `admin/admin` does not sign in either. Any other service on the
  computers network that sends requests where it is told is the same kind of relay, and network limits
  close that (E5-3).
- **Computers run unprivileged.** The browser and shell run as a non-root user in a container with all
  capabilities dropped, `no-new-privileges`, and pids and memory limits. A page exploit or a fork bomb stays
  inside one person's computer and cannot take it over.
- **Addresses are checked after resolving.** The computer's filter checks every address a name resolves to,
  in every spelling (IPv4-mapped IPv6, NAT64), and connects only to the address it checked.
- **The audit trail cannot be rewritten.** A trigger refuses UPDATE and DELETE on audit rows, and an action
  whose audit row cannot be written does not run.
- **An approval is spent once.** It is bound to the exact action, refused if that changes, never repeated
  after a crash, and a "No" covers equivalent actions. Credentials, security settings and payments always go
  to the person, whatever the rules say (E2-6).
- **Secrets are typed by the person, not the chat.** When a Bot needs a password it asks; the person types
  it into a separate field that goes straight to the computer. The audit row records that a secret was
  supplied and its length.

### On AWS

- A Bot has a shell. On AWS a shell can reach `169.254.169.254`, which hands out the machine's IAM
  role. Require IMDSv2 with a hop limit of 1 on every node, and block that range in network policy.
  OpenBot found this the hard way: [PR #620](https://github.com/CopilotKit/openbot/pull/620).
- The Docker provider talks to the Docker socket, which is root on that machine. That is fine on a
  laptop and is replaced by the ECS or Kubernetes API on AWS.

## Reference

The OpenBot source is the reference implementation for every idea here. Its
[`docs/architecture.md`](https://github.com/CopilotKit/openbot/blob/main/docs/architecture.md) and
`charts/openbot/README.md` are the most useful starting points.
