# Take control

A person takes the Bot's computer from the panel, clicks on the live screen themselves, and hands it back.
While the person holds it, every Bot action is refused, shown as a failed card, told to the model, and
audited as `deny`. Who holds the computer survives a server restart.

## Sub-features

- `control-take` `Take control` (rail or panel) → status "You have control. The Bot waits until you hand it back."
- `control-refuse` a Bot action meanwhile is a failed card and a `deny` audit row.
- `control-click` a click on the frame clicks the computer.
- `control-handback` `Hand back` folds the panel; the Bot continues from the page the person left.
- `control-restart` after a restart the person still holds it; `Start the computer` starts a fresh one.

## How to get to it (user POV)

- Folded rail: the pointer button (aria-label `Take control`) on the right edge.
- Open panel: the `Take control` button in its bar while the Bot holds the computer.
- While holding: `Hand back`, and `Start the computer` when no computer runs.

## Driving it with stack.sh

Preconditions: baseline, plus the Bot has opened `/link` in an earlier turn (see browse.md; script
navigate + `Say "The page is open."`, `wait-answer 1 "The page is open."`), and the panel is `"folded"`.

- **Take.** `$S ab find role button click --name "Take control"`. Within 15 s
  `$S ab get text .live-screen__status` reads `You have control. The Bot waits until you hand it back.`
  and the panel state is `"open"`. `$S shot control-taken`.
- **Refuse.** Script navigate to `http://fixture:8080/injection` + `Say "A person has control, so I will wait."`,
  send any message, `wait-answer 2 "A person has control, so I will wait."`.
  `$S ab get count '.tool-call[data-tool="navigate"][data-status="failed"]'` → `1`. `$S requests` contains
  `navigate did not run: a person has control of your computer.`
- **Click.** `$S ab click .live-screen__frame` (the blue link fills the screen). Within 15 s the frame's
  centre is no longer blue (`$S shot control-clicked` shows "You followed the link").
- **Hand back.** `$S ab find role button click --name "Hand back"`; state → `"folded"` within 15 s. Script
  snapshot + `Say "I am on Followed."`, send, `wait-answer 3 "I am on Followed."`; the snapshot card contains `Title: Followed`.
- **Audit.** `$S audit --save` reads in order: `navigate·allow, navigate·succeeded, control_taken·allow,
  control_taken·succeeded, navigate·deny, control_released·allow, control_released·succeeded,
  snapshot·allow, snapshot·succeeded`. `$S trace <control_taken trace_id>` shows `ComputerControl.take` with
  events `control.door_closed,control.taken`.
- **Restart.** Take control again, then
  `docker compose --project-name aobot-verify -f docker-compose.yml -f verify/compose.yml up --detach --wait --no-deps --force-recreate server`,
  reopen the page. Status reads `You have control, but the computer is not showing a page.`;
  `find role button click --name "Start the computer"` brings a frame back. Hand back at the end.

## Gotchas

- The rail button and the panel button share the name `Take control`; `find role button` hits whichever is
  shown. That is intended.
- Taking control waits for the Bot's in-flight actions ("Waiting for the Bot's last action…"). Take it
  while the chat is idle unless that wait is what you test.
- After the restart step the computer container is a new one; `down` still removes it by name.
- `vp run verify E1-5` is the full scripted version of this file.
