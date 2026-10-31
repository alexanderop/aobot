---
id: E0-5
title: Chat on my own subscription
epic: E0
status: done
depends_on: [E0-3]
estimate: 3d
---

# E0-5 · Chat on my own subscription

**Story:** As a developer on my laptop, I chat with a Bot that runs on my own Claude Code or Codex subscription, with no API key.

## Scope

In:

- The `acp` provider of `AgentRuntime`: spawn the CLI's ACP adapter, `initialize`, `session/new`, stream
  `session/update` into `ChatEvent`s, stop the whole process group on cancel
- Supported CLIs listed in `Config`: Claude Code, Codex, OpenCode. Each starts with its own tools switched off
- Our gateway tools offered as one MCP server in `session/new` (empty until E1-1)
- `session/request_permission`, `fs/*` and `terminal/*` requests refused unless they name a gateway tool;
  the client capabilities we advertise are `fs: false`, `terminal: false`
- The server refuses `AGENT_RUNTIME=acp` unless single-user mode is on and it listens on loopback
- An agent runtime contract suite that runs against `api` and every supported CLI
- One `session/prompt` per ACP session at a time, under the E0-1 conversation guard; CLI silence counts toward the stall watchdog
- Each CLI points at the E0-3 mock model server in tests through its own base URL variable

Out:

- Sign-in (E3). A subscription is one person's, so `acp` never runs for more than one
- Cloud (E5). `acp` is laptop only

## Demo

1. Sign in to Claude Code on the laptop as usual. Set `AGENT_RUNTIME=acp` and `ACP_AGENT=claude-code`.
2. Run the E0-1 demo. The answer streams word by word.
3. Switch to `ACP_AGENT=codex` and send another message. It answers too.

## Layers

server · infra

## Audit

A refused `request_permission`, `fs/*` or `terminal/*` request is a `deny` row naming the CLI and what it asked for.

## Telemetry

`AgentRuntime.turn` with the CLI name and version as attributes.

## Tests

- Tier 2: a fake ACP agent asking for `terminal/create` is refused and an audit row is written.
- Tier 3: the contract suite, with each CLI pointed at the scripted model: asked to run `env` and to read
  `/etc/passwd` outside the gateway, both fail. Streaming and cancel behave the same as `api`.
- Tier 4: the demo with Claude Code.

## Reference

- t3code `packages/effect-acp/` (typed ACP client in Effect v4) and
  `packages/provider-acp/src/server/AcpSessionRuntime.ts` (spawn, stream, SIGTERM then SIGKILL of the group).
  Its `clientPolicy.ts` says the catch: ACP agents run their own tools and only _ask_. That is why built-ins
  are switched off and the contract suite proves it.
- buzz `crates/buzz-acp/src/acp.rs`: the smallest complete ACP client.
- Check each CLI's current flag for switching built-in tools off before writing the launcher.
