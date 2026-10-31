---
id: E1-6
title: Files in and out of the workspace
epic: E1
status: todo
depends_on: [E1-3]
estimate: 2d
---

# E1-6 · Files in and out of the workspace

**Story:** As a person, I download the file my Bot made and give it a file to work on, without copying text through the chat.

## Scope

In:

- Download a file from `/workspace` from the chat (a file chip under the Bot's message), exact bytes, 100 MB cap
- Upload a file into `/workspace` from the composer, same cap
- Bot tools `read_file`, `write_file`, `list_files` through the gateway, with rules seeing `file.path`, `file.name`, `file.extension`
- Paths are confined to `/workspace`: `..`, absolute paths and symlinks leading out are refused on the computer
- File contents reach the model as untrusted data; audit rows keep the path and size, never the contents

Out:

- Files on the Mac (E4-3)

## Demo

1. Upload `expenses.csv` and ask: "Add a total row and save it as expenses-total.csv."
2. A file chip appears under the answer. Download it: the total row is there.
3. Ask the Bot to read `/etc/passwd` through `read_file`: refused.

## Layers

web · server · gateway · computer

## Audit

`file.uploaded`, `write_file · allow` with path and size, `file.downloaded`, `read_file · deny · outside workspace`.

## Telemetry

File size as a span attribute.

## Tests

- Tier 1: path confinement cases, including a symlink inside `/workspace` pointing at `/etc`.
- Tier 3: a 101 MB upload is refused; a download returns the exact bytes.
- Tier 4: the demo.

## Reference

- OpenBot `agent-computer/src/workspace.ts` (confinement, download cap), `agent-computer/src/index.ts` (`/files/*`).
