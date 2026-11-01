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

## Gateway tools

Every tool a Bot has, in either runtime. The tool map test (`apps/server/src/features/gateway/tool-map.test.ts`)
fails when a tool in `botToolkit` is missing here or a row here names no tool. Each call writes the `allow`
row first, then one outcome row linked to it by `outcome_of`. Both carry the turn's `trace_id`; the outcome row
copies the action, and its `detail` says why for `failed` and `unknown`.

| Tool       | Parameters    | Computer action                                               | Audit rows                                                                                                                                  |
| ---------- | ------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `navigate` | `url`         | `POST /act {"action":"navigate","url"}`                       | `navigate · allow` with `{ url }`, then `succeeded`, `failed` or `unknown`                                                                  |
| `snapshot` | none          | `POST /act {"action":"snapshot"}`                             | `snapshot · allow` with `{}`, then `succeeded`, `failed` or `unknown`                                                                       |
| `click`    | `ref`         | `POST /act {"action":"click","target":{ref,role,name}}`       | `click · allow` with `{ ref, role, name }`, then `succeeded`, `failed` or `unknown`; `click · deny` with `{ ref, reason }`                  |
| `type`     | `ref`, `text` | `POST /act {"action":"type","target":{ref,role,name},"text"}` | `type · allow` with `{ ref, role, name, text: "[N chars]" }`, then `succeeded`, `failed` or `unknown`; `type · deny` with `{ ref, reason }` |
| `run`      | `command`     | `POST /act {"action":"run","command"}`                        | `run · allow` with `{ command }` (capped at 2,000 characters), then `succeeded`, `failed` or `unknown`                                      |

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

| Hook                    | Shaped like CopilotKit's             | What it gives a component                                                               | From |
| ----------------------- | ------------------------------------ | --------------------------------------------------------------------------------------- | ---- |
| `useConversation(id)`   | `useAgent`                           | `transcript` (messages and tool calls in order), `isRunning`, `send`, `stop`            | E0-1 |
| `useToolCallRenderer()` | `useRenderTool`, `useRenderToolCall` | A registry from tool name to a component that draws one tool call in each of its states | E1-1 |
| `useLiveScreen(bot)`    | (none)                               | The latest screen frame, and `takeControl` and `handBack`                               | E1-4 |

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

The `Computers` service has four operations, the same as OpenBot's supervisor. There is one shared
computer until E3-3 adds a `person` argument:

```ts
export interface Interface {
  readonly ensure: Effect.Effect<Computer, ComputerUnavailable>; // start if needed, wait until healthy
  readonly stop: Effect.Effect<void, ComputerUnavailable>;
  readonly reset: Effect.Effect<void, ComputerUnavailable>;
  readonly list: Effect.Effect<ReadonlyArray<ComputerStatus>, ComputerUnavailable>;
}

// A running computer: a URL and a token, whichever provider started it. Both methods are `POST /act`,
// and each reads only the answer its action promises, so a page answering a command is ComputerLost.
export interface Computer {
  readonly browse: (
    action: PageAction,
  ) => Effect.Effect<PageRead, ComputerActFailed | ComputerLost>;
  readonly run: (
    command: RunCommand,
  ) => Effect.Effect<CommandRan, ComputerActFailed | ComputerLost>;
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
- **`/act` refuses callers on the computer itself.** A request from a loopback address or from one of the
  computer's own addresses gets 403 before its token is read, so a command that finds the token cannot
  drive the browser around the gateway. What remains: commands run as the same user as the computer's own
  process, so they can read its environment and memory (`/proc/<pid>/environ`, and likely `ptrace`), and
  `setsid` lets a command leave its process group and outlive its time limit or a Stop. Running commands
  as a separate user, or in a sidecar, closes both (see `docs/backlog/later.md`).
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
