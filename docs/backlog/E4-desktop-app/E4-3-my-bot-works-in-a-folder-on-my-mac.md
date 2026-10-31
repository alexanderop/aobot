---
id: E4-3
title: My Bot works in a folder on my Mac
description: As a colleague with the desktop app open, I let my Bot read, write and run commands in one folder on my Mac, and it still has its cloud computer for everything else.
epic: E4
status: todo
depends_on: [E4-1, E2-5]
estimate: 4d
---

# E4-3 · My Bot works in a folder on my Mac

**Story:** As a colleague with the desktop app open, I let my Bot read, write and run commands in one folder on my Mac, and it still has its cloud computer for everything else.

## Scope

In:

- The `mac` computer: the desktop app connects out to the server over one authenticated WebSocket and
  pulls operations; the server never dials the laptop. Gone when the app closes or signs out
- Computer tools take `computer: "cloud" | "mac"`; rules see `computer.kind`
- The person grants a folder per Bot through the macOS folder dialog; grants are listed and revocable
  in the app. Paths outside a granted folder, and symlinks leading out of one, are refused on the Mac
- `mac_run`: a native "Allow?" dialog naming the Bot and the exact command, every time by default; runs
  in the folder under `sandbox-exec` with no network and writes only inside the folder
- Only the signed-in owner's own Bots, in a conversation they are watching, reach their Mac. A routine or
  another person's Bot is refused
- Grants are read-only unless the person ticks "writable"
- "Stop all" in the app ends running commands, revokes every grant and fails waiting operations; revoking one grant ends its running command
- Every operation has an id and a lease; the Mac runs an id once, so a slow "Allow?" dialog never makes a confirmed command run twice. Waiting operations expire
- Before a file is overwritten, the old one is copied to `.aobot-backups/` in the folder; the dialog says commands cannot be undone

Out:

- The browser on the Mac (E4-4)
- Remembered "always allow" for a command (later)

## Demo

1. Open the desktop app. Grant the Assistant `~/aobot-demo`.
2. Ask: "List the files in my demo folder on my Mac, then create summary.md in your cloud workspace."
3. A native dialog asks to run `ls`. Allow it. The Bot lists the Mac files, then writes in `/workspace`.
4. Ask it to read `~/.ssh/id_ed25519`. It is refused: outside the granted folder.
5. Quit the app. Ask again: "your Mac is not connected".

## Layers

desktop · server · gateway

## Audit

`mac.folder_granted`, `run · allow · computer=mac`, `mac.command_confirmed` or `mac.command_declined`,
`read_file · deny · outside granted folder`, `mac.connected`, `mac.disconnected`. `mac.stopped_all`, `mac.grant_revoked`.

## Telemetry

`computer.kind` on every `Gateway.act` span.

## Tests

- Tier 1: path resolution refuses `..`, absolute paths and symlinks leaving the folder.
- Tier 2: a `mac` call with no connected app fails at once; a call from another person's Bot is refused.
- Tier 3: the computer contract suite runs against `mac` with the dialog answered by the test.
- Tier 4: the demo, with the app launched headless.
- Tier 2: an operation re-delivered after its lease runs once on the Mac.
- Tier 2: a write into a read-only grant is refused; Stop all fails a waiting operation.

## Reference

OpenBot `server/src/host-access/` (`broker.ts` leases operations to the polling desktop, `tools.ts` the
`host_*` tools with a native confirm per command).
