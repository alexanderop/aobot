# Shell

The Bot runs a bash command in `/workspace`, its own folder on its own computer. The transcript shows a
`run` card with the exit code and the tail of its output. The command is audited as written (capped),
and the server's database and the server itself are out of reach from that shell.

## Sub-features

- `shell-run` a command runs and its output shows in the card.
- `shell-files` files the Bot creates stay in `/workspace` on its computer.
- `shell-isolation` `/data/aobot.db` is not there; `curl http://server:3000` through the proxy fails.

## How to get to it (user POV)

- Ask the Bot in chat to create or list files. The model calls `run`; on the mock model, `$S script` does.

## Driving it with stack.sh

Preconditions: baseline.

- **Script.** `$S script` with
  `[{"_tag":"CallTools","calls":[{"name":"run","params":{"command":"echo hello > notes.txt && ls"}}]},{"_tag":"Say","words":["Made"," notes.txt."]}]`.
- **Ask.** fill `Message Assistant` with `Create notes.txt and list the folder.`, Enter,
  `$S wait-answer 1 "Made notes.txt." 90`.
- **Card.** `$S ab eval "document.querySelector('.tool-call[data-tool=\"run\"] .tool-call__result').textContent"`
  contains `notes.txt`.
- **Side effect.** `docker exec aobot-verify-computer cat /workspace/notes.txt` prints `hello`.
- **Audit.** `$S audit --save`: `run·allow` with `detail` `{"command":"echo hello > notes.txt && ls"}`, then
  `run·succeeded`.
- **Isolation.** Script `run` with `ls /data/aobot.db`, then with
  `curl --silent --show-error --fail-with-body --max-time 3 http://server:3000`. Both cards show a non-zero
  exit (`No such file`, a proxy refusal).

## Gotchas

- Commands are stopped after the server's time limit; a `sleep` longer than that ends as stopped, not done.
- The shell gets only PATH, locale, HOME, DEBIAN_FRONTEND and the proxy settings. A command that bypasses
  the proxy is E5-3's problem, not a bug in this feature.
- `docker exec` is for reading the side effect only. Never create files there to make a step pass.
