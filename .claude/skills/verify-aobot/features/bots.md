# Bots

An admin defines the Bots in the root `bots.yaml`: a name, instructions, the tools each is granted, and
whether the sidebar pins it or lists it under a group. A person picks a Bot in the sidebar and chats with
it; each conversation belongs to the Bot of its first message. When a Bot asks for a tool it was not
granted, the gateway refuses it before anything runs, and the transcript, the model and the audit all say
`not granted to <bot>`.

## Sub-features

- `bots-sidebar` the pinned Bots (Assistant, Scribe) as a grid of avatars, then Researcher under
  `research` and Operator under `dev stuff`, each with its own drawn character.
- `bots-pick` clicking a Bot opens its conversation; the URL says `?bot=<id>&c=<id>`, the header pill and
  the composer name it, picking another Bot then this one again returns to the same conversation, and
  Back returns to the Bot before.
- `bots-refuse` Researcher (granted snapshot, navigate, click) asked to run a command: one `run · deny`
  with `{ "bot": "researcher", "reason": "not granted to researcher" }`, no allow row, the computer never
  starts.
- `bots-invalid` a `bots.yaml` that is not valid stops the server with the reason.

## How to get to it (user POV)

- Open http://localhost:3100: the sidebar is on the left, Assistant is open.
- Click a Bot's avatar or row, each a link to `?bot=<id>`. Type in `Message <Bot name>`.

## Driving it with stack.sh

Preconditions: baseline.

- **Sidebar.** `$S ab eval "[...document.querySelectorAll('nav[aria-label=\"Bots\"] a')].map((a) => a.textContent)"`
  reads `["Assistant","Scribe","Researcher","Operator"]`. `$S shot bots-sidebar-01`.
- **Pick.** `$S ab find role link click --name "Researcher"`; `$S ab get url` has `bot=researcher`;
  the selected link has `aria-current="page"`. `$S ab back` returns to Assistant.
- **Refuse.** `echo '[{"_tag":"CallTools","calls":[{"name":"run","params":{"command":"ls"}}]},{"_tag":"Say","words":["I may not."]}]' | $S script`,
  fill `Message Researcher`, Enter, `$S wait-answer 1 "I may not." 90`. The run card is
  `data-status="failed"` and reads `run did not run: it is not granted to researcher`. `$S audit` holds one
  row, `run · deny`. `docker ps --filter name=aobot-verify-computer` is empty.
- **Invalid file.** Not on this stack (it mounts the root file). On the host:
  `BOTS_FILE=/tmp/bad.yaml node apps/server/src/app/main.ts` with a file naming a tool that does not exist
  exits 1 with `BotsFileInvalid: … is not a valid bots file: Expected "navigate" | … at ["bots"][0]["tools"][1]`.

## Gotchas

- `vp run verify E2-1` is the scripted proof of `bots-sidebar`, `bots-pick` and `bots-refuse`.
- The server reads `bots.yaml` once at start-up. After editing it, restart the server (`docker compose
  restart server`); no rebuild.
- Every Bot shares the one computer until E3-3: a person who takes control holds it for every Bot.
- A conversation keeps its first Bot: a URL naming another Bot with that conversation is corrected to the
  conversation's own Bot, in the URL, the sidebar and the header.
