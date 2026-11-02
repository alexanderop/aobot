# Design

aobot looks and feels like a messenger where your coworkers happen to be Bots. The reference is a
screenshot Alexander shared of a Bot messenger (a dark sidebar of Bots with character avatars, chat
bubbles, an inline approval card). This page describes that look so it can be built without the
screenshot.

## Principles

1. **A Bot is a contact, not a tool.** You open a Bot like you open a chat with a colleague.
2. **Calm and dark.** A near-black background, quiet greys, one accent colour for "you" and for actions.
3. **Asking is part of the conversation.** When a Bot needs a yes or no, the question appears as a card
   in the chat with the answer buttons inside it, not as a modal.
4. **The computer is a side panel.** The live screen opens beside the chat when a Bot is working or you
   hold its computer, and folds to a slim rail with one Take control button when neither is true.

## Layout

```
┌──────────────────────┬──────────────────────────────────────────────────────────┐
│          🔍  ＋      │                   ( ● Fitness Coach )                    │
│  ● Chief  ● QS   ● … │                       today 3:14 PM                      │
│  ● To-Do  ● Lesen ●  │                       ┌─────────────────────────────────┐│
│                      │                       │ your message (accent bubble)    ││
│  fitness             │                       └─────────────────────────────────┘│
│  ● Fitness Coach     │ ┌───────────────────────────────┐                        │
│    last message…     │ │ Bot message (grey bubble)     │                        │
│  ● Essensplaner      │ └───────────────────────────────┘                        │
│  dev stuff           │ ┌───────────────────────────────┐                        │
│  ● alexop.dev      • │ │ Shall I delete the 18:00 slot? │                        │
│  news                │ │ [A] Yes, update the calendar  │                        │
│  ● Filme & Serien  • │ └───────────────────────────────┘                        │
│                      │ ┌─────────────────────────────────────────────────── 🎙 ◉┐│
│ (me) Alexander    ⊞  │ │ ＋  Message Fitness Coach                              ││
└──────────────────────┴──────────────────────────────────────────────────────────┘
```

### Sidebar

- **Top:** search and "new Bot" as round icon buttons.
- **Pinned Bots:** a grid of three per row, large character avatars with the name underneath, an unread
  dot on the avatar.
- **Groups:** a small muted heading per group (`fitness`, `dev stuff`, `news`), then one row per Bot:
  avatar, name, a one-line preview of the last message, an unread dot on the right.
- **Selected row:** a slightly lighter rounded background.
- **Bottom:** your photo and name, and an apps button.

E2-1 builds the pinned grid, the groups and the selected row. A pinned Bot shows only in the grid, and a
Bot in no group is listed just below it without a heading. Search and "new Bot" wait for creating Bots
in the app, previews and unread dots for E3-2, and the bottom bar for people (E3).

### Conversation

- **Header:** the Bot's avatar and name in a pill, centred, with the time below. Until the conversation
  opens the pill says Connecting…, and Unavailable with a `--danger` dot when it cannot.
- **Your messages:** right-aligned, accent background, dark text (`--bg`, 4.5:1 or better), large radius.
- **Bot messages:** left-aligned, dark grey background, max ~60% width. A Bot's consecutive messages are
  separate bubbles stacked with a small gap, not one long block.
- **Rich text:** bold, bullet lists, line breaks render inside the bubble.
- **Approval card:** a grey card with the question in muted bold text and one or more answer rows, each
  with a lettered key (`A`, `B`) in an accent square. Choosing one sends it as your reply and writes an
  audit row. Built in E2-5 below the transcript: the question the server worded from the action, with
  the whole command, address or text as the Bot wrote it, wrapped and scrolling when long, rows `A Yes`
  and `B No` on `--row-active`, disabled while the answer is on its way, why the server refused it in
  `--danger`, and "You answered Yes" or "You answered No" for the rest of that turn only.
- **Secret entry:** when a Bot asks for a password with `request_secret`, its card says what it asks for
  in the Bot's words, on the host of the page the server read ("Asks for the password on
  shop.example"), so a Bot cannot pass one site's field off as another's. Until the server shows the
  request, the card says only what the Bot asked for, with nothing to type. Then it has a password input on
  `--row-active`, a Supply pill in the accent colour and a Decline pill, and a muted line saying the
  secret goes straight to the Bot's computer. The buttons are disabled while the answer is on its way,
  and why the server refused it shows in `--danger`. Once answered the card says "Supplied …" or
  "Declined to give …", and "Supplied …, not typed" when the computer then typed nothing, as when a
  person took control; never the value.
- **Composer:** a full-width rounded bar at the bottom: `＋` for attachments, placeholder
  "Message <Bot name>", a microphone button, and a round accent voice button.
- **Attachments:** a file picked with `＋` uploads into the Bot's workspace at once and shows above the
  bar as a chip on `--row-active`: its name, "Uploading…" in `--muted` while it goes, why it failed in
  `--danger` (too large, say), and `×` to take it away, which also stops an upload still going. Send
  waits while a file is still uploading, and the chips it named clear once the message went.
- **File chip:** a file the Bot saved shows in its card as a chip on `--row-active` with an accent page
  icon and the file's name in bold. Clicking it downloads the file.

### Live screen

- **Folded:** a slim rail on the right with one round icon button, Take control.
- **Open:** a bar above the screen says who holds it, with pill buttons: Take control, Taking control…
  (disabled while the Bot's last actions finish), or Hand back in the accent colour. While you hold a
  computer that shows no page, such as after a restart, the bar says so and offers Start the computer
  beside Hand back.
- **While your last command is on its way:** a take, a click or a hand back, the rail's button, Take
  control, Hand back and Start the computer are disabled, so one press sends one command. The screen
  still takes clicks.
- **While you hold it:** the screen has an accent outline and a crosshair cursor, and a click on it clicks
  there on the Bot's computer.
- **When a take, a click or a hand back failed:** the panel opens and says why in `--danger` text under
  the bar, until your next command or until control changes hands.

### Audit page

- **Where:** `/audit`, a page of its own, linked as Audit trail in `--muted` text at the bottom of the
  sidebar. Back to the Bots returns to the messenger.
- **Filters:** a `--bubble` card of fields on `--row-active`: Bot (as `bots.yaml` names them), Person,
  Decision, From and Before (the browser's own time, to the minute), then a Filter pill in the accent colour
  and a Clear pill. The URL keeps the filters, so a reload or a copied link shows the same rows, and Back
  returns to the filters before. Filter on the filters already shown reads the trail again, with no new
  history entry.
- **Rows:** a table, newest first: the time, the Bot, the person (with "by the server" for a row the
  deployment wrote), the action and the decision in words ("Run a command", "Refused"), why (the rule in a
  code chip, then the reason), and Trace, which opens the row's trace in Grafana in a new tab. Refused and
  Failed are `--danger`, Outcome unknown `--muted`. An action or a decision the page has no words for reads
  Unknown, never Allowed.
- **Paging:** 50 rows at a time; Load more reads the next page after the last row shown, and is gone once
  there is none. Why a page did not arrive shows in `--danger`, and the rows read before it stay; Load
  more asks for that page again. When no rows came, Try again reads the trail again from the newest row.

### Bot avatars

Each Bot gets a simple, friendly character: a soft blob shape in one solid colour with two eyes. Colour
and shape tell Bots apart at a glance. They are our own set, not the reference's characters: five blob
bodies, ten colours and four gazes drawn as inline SVG and picked from a hash of the Bot's id, so a Bot
looks the same on every page and a new Bot in `bots.yaml` needs no image file.

## Tokens (starting point)

| Token          | Value                                          | Use                                     |
| -------------- | ---------------------------------------------- | --------------------------------------- |
| `--bg`         | `#0f0f10`                                      | app background                          |
| `--sidebar`    | `#141415`                                      | sidebar                                 |
| `--bubble`     | `#1f1f21`                                      | Bot bubbles, cards, composer            |
| `--row-active` | `#232325`                                      | selected sidebar row                    |
| `--divider`    | `#232325`                                      | the line between the chat and a panel   |
| `--fg`         | `#ececed`                                      | text                                    |
| `--muted`      | `#8a8a8f`                                      | previews, group headings, times         |
| `--accent`     | `#3fa592`                                      | your bubbles, voice button, answer keys |
| `--unread`     | `#3b82f6`                                      | unread dots                             |
| `--danger`     | `#e5766b`                                      | failed tool calls, what went wrong      |
| radius         | 18px bubbles, 12px rows, full for icon buttons |                                         |
| font           | system sans, 15–16px body                      |                                         |

Dark is the main theme. A light theme is a later ticket.

## Where this lands in the backlog

| Ticket                                                                              | Design work                                     |
| ----------------------------------------------------------------------------------- | ----------------------------------------------- |
| [E0-1](backlog/E0-walking-skeleton/E0-1-chat-with-a-bot-locally.md)                 | Tokens, conversation view, composer (text only) |
| [E1-4](backlog/E1-a-computer/E1-4-watch-the-live-screen.md)                         | Live screen as a side panel                     |
| [E1-5](backlog/E1-a-computer/E1-5-take-control-and-hand-back.md)                    | Take control rail, control bar                  |
| [E1-6](backlog/E1-a-computer/E1-6-files-in-and-out-of-the-workspace.md)             | Attachment chips, file chip                     |
| [E2-1](backlog/E2-roles-and-guardrails/E2-1-bots-from-a-file-with-granted-tools.md) | Sidebar with groups, pinned Bots, avatars       |
| [E2-3](backlog/E2-roles-and-guardrails/E2-3-never-record-secrets.md)                | Secret entry card                               |
| [E2-4](backlog/E2-roles-and-guardrails/E2-4-an-audit-page-people-can-read.md)       | Audit page                                      |
| [E2-5](backlog/E2-roles-and-guardrails/E2-5-ask-before-risky-actions.md)            | Approval card                                   |
| [E3-2](backlog/E3-people/E3-2-my-conversations-only-mine.md)                        | Last-message previews and unread dots           |
