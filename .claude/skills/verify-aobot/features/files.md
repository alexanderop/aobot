# Files

A person puts a file into the Bot's `/workspace` from the composer, and downloads a file the Bot saved
from a chip under its answer. The Bot reads, writes and lists files there with `read_file`, `write_file`
and `list_files`. A path outside the workspace, or a link that leads out of it, is refused. Audit rows
keep a file's path, name, extension and size, never what it holds.

## Sub-features

- `files-upload` `＋` in the composer uploads the picked file at once; its chip says Uploading…, then just
  its name; the message sent then ends with `I put <name> in your workspace.`
- `files-too-large` a file past 100 MB is refused in the composer, and by the server with 413.
- `files-tools` `read_file`, `write_file`, `list_files` cards; contents reach the model as
  `source="file contents"`.
- `files-download` a done `write_file` card holds `a.file-chip`; clicking it downloads the exact bytes.
- `files-confinement` `read_file /etc/passwd` is `read_file · deny` with `reason: "outside workspace"`.

## How to get to it (user POV)

- Press `＋` (aria-label `Attach a file`) and pick a file, then ask the Bot to work on it.
- Ask the Bot to save something as a file; download it from the chip under the card.

## Driving it with stack.sh

Preconditions: baseline. A file on the host to upload, e.g. `printf 'a,1\n' > /tmp/expenses.csv`.

- **Upload.** `$S ab upload 'input[type="file"]' /tmp/expenses.csv`, then poll
  `$S ab get count '.attachment[data-status="ready"]'` until 1. The upload starts the computer.
- **Script.** `[{"_tag":"CallTools","calls":[{"name":"read_file","params":{"path":"expenses.csv"}}]},{"_tag":"CallTools","calls":[{"name":"write_file","params":{"path":"total.csv","contents":"a,1\ntotal,1\n"}}]},{"_tag":"Say","words":["Saved."]}]`.
- **Ask.** fill `Message Assistant`, Enter, `$S wait-answer 1 "Saved." 90`.
- **Download.** `$S ab download '.tool-call[data-tool="write_file"] a.file-chip' /tmp/total.csv`, then
  compare the bytes with what the script wrote.
- **Audit.** `$S audit --save`: `file.uploaded·allow` `{path,name,extension,bytes}`, `·succeeded`;
  `read_file`, `write_file` (with `bytes`), `file.downloaded·allow`, `·succeeded`.
- **Confinement.** Script `read_file` with `{"path":"/etc/passwd"}`; the card fails and the row is
  `read_file·deny` with `reason` `outside workspace`.

## Gotchas

- `file.downloaded · succeeded` is written once the last byte went out, a moment after the click.
- Paths are relative to `/workspace`: `/workspace/notes.txt` is absolute and refused like `/etc/passwd`. Only `/` separates: `a\b.txt` is one name.
- The server refuses an upload or a download from another site's page (Origin, or `Sec-Fetch-Site:
  cross-site`), or sent to a name that is not this machine's or `PUBLIC_HOST` (`Host`), with 403. Drive it
  from the page at http://localhost:3100.
- Both routes are `/files?path=`: `GET` downloads, `PUT` uploads, as on the computer.
  `HEAD` is 405 and writes no row.
