# Chat

A person types a message to the Bot `Assistant`, sees it in the transcript, watches the answer stream in
word by word, and finds the whole conversation again after a reload. While a turn runs, Send becomes Stop.

## Sub-features

- `chat-send` the message appears as the person's bubble right away.
- `chat-stream` the answer appears word by word, not all at once.
- `chat-persist` a reload of the same `?c=<id>` URL shows both bubbles again.
- `chat-stop` Stop ends a running turn.

## How to get to it (user POV)

- Open http://localhost:3100. The page creates a conversation and puts its id in the URL as `?c=<id>`.
- Type in the `Message Assistant` box, press Enter (or the `Send` button). Shift+Enter adds a line.
- While a turn runs, the `Stop` button replaces `Send`.

## Driving it with stack.sh

Preconditions: baseline. No script set (the default answer is fine), or set one `Say`.

- **Send.** `$S ab find placeholder "Message Assistant" fill "Say hi in five words"`, `$S ab press Enter`.
  `$S ab get text body` contains `Say hi in five words` within 5 s.
- **Stream.** Poll `$S answers` every ~200 ms right after sending. At least one read shows a partial answer
  (e.g. `["Hi there,"]`) before `$S wait-answer 1 "Hi there, nice to meet you!"` succeeds.
- **Persist.** `$S ab get url` (keep the `?c=`), `$S ab reload`, `$S ab wait --load networkidle`.
  `$S answers` still reads `["Hi there, nice to meet you!"]` and the URL is unchanged.
- **Stop.** Script a long turn: `echo '[{"_tag":"CallTools","calls":[{"name":"run","params":{"command":"sleep 20"}}]},{"_tag":"Say","words":["Done."]}]' | $S script`.
  Send a message, wait until `$S ab get count '.tool-call[data-tool="run"][data-status="running"]'` is `1`,
  then `$S ab find role button click --name "Stop"`. Within a few seconds `Send` is back
  (`$S ab is visible 'button[aria-label="Send"]'`) and no answer reads `Done.`.
- **Proof.** `$S shot chat-persist-after-reload`, `$S snap chat-persist-after-reload`, `$S trace <trace_id>`
  of the turn shows one `Chat.turn` root.

## Gotchas

- The default mock answer streams at ~150 ms per word; a read right after Enter may see nothing yet.
- `wait-answer` matches the exact full text; a partial answer is not a timeout bug.
- `chat-stop` is not covered by any `vp run verify` scenario yet. What Stop leaves in the transcript and the
  audit is not pinned; report what you saw rather than assume.
- Opening http://localhost:3100 without `?c=` starts a new, empty conversation.
