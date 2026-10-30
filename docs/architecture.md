# Architecture

## What aobot is

A chatbot answers. A coworker acts: it opens pages, fills in forms, runs scripts. aobot gives each Bot
three things:

| | What it means | Where it lives |
| --- | --- | --- |
| **A role** | A name, instructions, and the tools it is granted | `bots.yaml`, later the admin UI |
| **A computer** | Its own Chromium, bash and `/workspace`, in a container | `apps/computer` |
| **Guardrails** | Grants, rules that fail closed, an audit trail, a person who can take over | `apps/server` gateway |

## The five parts

```
 Desktop app / web page ──► Server ──► Agent (Claude Agent SDK)
                              ▲              │ tool call
                              │              ▼
                              └──── Gateway: granted? → rules? → audit row → forward
                                                                   │
                                                                   ▼
                                                 Computer (container: Chromium, bash, /workspace)
```

| Part | Its one job | Built with |
| --- | --- | --- |
| `apps/web` | Show the conversation and the live screen, let a person take the mouse | React |
| `apps/desktop` | Wrap `apps/web`, keep the sign-in token safe, send notifications | Electron |
| `apps/server` | Know Bots and people, run agent turns, stream answers | Effect on Bun |
| Gateway (in server) | Decide if a tool call may happen, record it, then forward it | Effect service + Postgres |
| `apps/computer` | Actually do it: browse, click, type, run commands | Bun + Playwright in Docker |
| `packages/domain` | Schemas shared by all of the above: Bot, ToolCall, AuditRow, ChatEvent | Effect Schema |

### Inside each app: features

Each app is split by feature, not by technical layer: `src/app` wires things together,
`src/features/<feature>` holds one capability end to end with `public.ts` as its only entry point, and
`src/shared` holds generic helpers. Which feature may use which is declared in
`tools/oxlint/aobot-architecture/policy.ts` and enforced by oxlint. See
[quality-gates.md § Feature-based architecture](quality-gates.md#feature-based-architecture).

The agent never talks to a computer directly. It can only ask, and the gateway answers. The feature graph
enforces this: only the `gateway` feature may depend on `computers`.

## Life of one request

1. A person sends a message with the Bot they picked.
2. The server starts an agent turn with the Bot's instructions and its granted tools.
3. The agent asks for a tool, for example `navigate`.
4. The gateway checks the grant, then the rules, and writes one audit row either way.
5. Only on "yes", the gateway asks the person's computer to act.
6. The computer returns the page as text: the accessibility tree, with a ref per element.
7. The agent reads it and decides the next step. Every step goes through the same door.
8. The answer streams back to the page, with each tool call shown between the text.

## Decisions

| # | Decision | Why |
| --- | --- | --- |
| 1 | **No CopilotKit Intelligence.** Threads, messages and audit live in our Postgres | No external licence, no data outside our account |
| 2 | **Claude Agent SDK** runs the think-act loop | It handles tool calls, sessions and streaming. Runs on an Anthropic API key or on AWS Bedrock |
| 3 | **Effect v4** on the server | Typed errors make every gateway path visible, layers make providers swappable, `Effect.fn` gives tracing for free |
| 4 | **Web first, Electron as a wrapper** | The agents run in the cloud, so the desktop app adds safe token storage and notifications, not core logic |
| 5 | **The page as text, not screenshots** | `ariaSnapshot({ mode: "ai" })` with refs is cheap and needs no vision model. Snapshots are capped at 12,000 characters |
| 6 | **A computer is only ever "a URL and a token"** | The server never uses `docker exec` or shared files, so where a computer runs can change freely |
| 7 | **Fail closed** | A missing rule permits nothing, a crashing rule denies, a missing grant is refused before any rule runs |
| 8 | **Never log what a Bot typed** | The audit row keeps `"[14 chars]"`, not the value. It may be a password |
| 9 | **OpenTelemetry from day one** | One trace per chat turn, with the `trace_id` stored on every audit row |

## Local now, AWS later

Two switches decide where things run. Code never checks which one is active.

| Switch | Local (now) | AWS (later) |
| --- | --- | --- |
| `COMPUTER_PROVIDER` | `docker`: one container per person, a named volume for its logins | `ecs` (RunTask in a private subnet), later `k8s` (agent-sandbox) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | the `grafana/otel-lgtm` container | the AWS OpenTelemetry collector (ADOT) or Grafana Cloud |
| `DATABASE_URL` | Postgres in Docker Compose | RDS Postgres with pgvector |
| Secrets | `.env` through Effect `Config` | AWS Secrets Manager |
| Model | Anthropic API key | Bedrock through an IAM role |

Rules that keep the move cheap:

1. Postgres locally, never SQLite, so there is no database migration later.
2. Settings and secrets only through Effect `Config`, never `process.env` in application code.
3. Computers never publish ports. Only the server's network can reach them.
4. The images Compose runs are the images AWS runs.
5. Every computer provider passes the same contract test suite before it is used. See [testing.md](testing.md).

The `Computers` service has four operations, the same as OpenBot's supervisor:

```ts
export interface Interface {
  readonly ensure: (person: PersonId) => Effect.Effect<Handle, Unavailable> // start if needed, wait until healthy
  readonly stop: (person: PersonId) => Effect.Effect<void, Unavailable>
  readonly reset: (person: PersonId) => Effect.Effect<void, Unavailable>
  readonly list: Effect.Effect<ReadonlyArray<ComputerStatus>, Unavailable>
}
```

## Security notes for AWS

- A Bot has a shell. On AWS a shell can reach `169.254.169.254`, which hands out the machine's IAM
  role. Require IMDSv2 with a hop limit of 1 on every node, and block that range in network policy.
  OpenBot found this the hard way: [PR #620](https://github.com/CopilotKit/openbot/pull/620).
- The Docker provider talks to the Docker socket, which is root on that machine. That is fine on a
  laptop and is replaced by the ECS or Kubernetes API on AWS.

## Reference

The OpenBot source is the reference implementation for every idea here. Its
[`docs/architecture.md`](https://github.com/CopilotKit/openbot/blob/main/docs/architecture.md) and
`charts/openbot/README.md` are the most useful starting points.
