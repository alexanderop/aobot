# Live screen

While the Bot uses its computer, a panel beside the chat (`aside` "The Bot's screen") opens and shows the
Bot's browser live, relayed over the page's own `/rpc` socket. When the turn ends, it folds to a rail with
one `Take control` button. Watching is not audited.

## Sub-features

- `screen-folded` before the Bot works, the panel is folded.
- `screen-open` during a computer turn the panel is open and the frame shows a page, not a blank one.
- `screen-fold` after the turn the panel folds again.
- `screen-token` the computer's token never reaches the page.

## How to get to it (user POV)

- Open the chat and ask for anything that uses the computer. The panel on the right opens by itself.

## Driving it with stack.sh

Preconditions: baseline. Script a turn long enough to watch:
`[{"_tag":"CallTools","calls":[{"name":"navigate","params":{"url":"http://fixture:8080/link"}}]},{"_tag":"CallTools","calls":[{"name":"run","params":{"command":"sleep 8"}}]},{"_tag":"Say","words":["Done."]}]`.

- **Folded first.** `$S ab eval "document.querySelector('.live-screen')?.dataset.state"` → `"folded"`.
- **Open while working.** Send any message. Once
  `$S ab get count '.tool-call[data-tool="navigate"][data-status="done"]'` is `1`, the state is `"open"` and
  `$S ab is visible .live-screen__frame` is true. `$S shot screen-open` shows the blue `Follow me` page.
- **Fold after.** `$S wait-answer 1 "Done." 60`, then within 5 s the state is `"folded"`.
- **Not audited.** `$S audit`: `allow` rows are only `navigate` and `run`.
- **Token.** `docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' aobot-verify-computer | grep COMPUTER_TOKEN`;
  that value is not in `$S ab get html html`.

## Gotchas

- Without `set media … reduced-motion` the fold animates and a click mid-slide lands beside the button.
- The frame is a JPEG stream: sample colours with tolerance (see `verify/screen.ts` `centreColour`).
- "Waiting for the screen…" is normal for the first second after the panel opens.
