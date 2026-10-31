---
title: Design
description: How aobot looks, a messenger where your coworkers happen to be Bots, described well enough to build without the reference screenshot.
---

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
4. **The computer is a side panel.** The live screen opens beside the chat when a Bot is working and
   folds away when it is not.

## Layout

Two columns. A fixed-width sidebar of Bots on the left (about 300px), the open conversation on the right
(content at most 860px wide, centred). The conversation is the sidebar's selected row.

On the docs site the screens below are the real components: the built ones render from `apps/web`, the
planned ones live in `apps/docs/src/features/design/planned/` until their ticket moves them into
`apps/web`. In this file `[caption](screen:<name>)` marks where a screen goes; the name is a key in
`apps/docs/src/features/design/screens.ts`.

[The planned layout: the sidebar beside a conversation with an approval card.](screen:layout)

### Sidebar

- **Top:** search and "new Bot" as round icon buttons.
- **Pinned Bots:** a grid of three per row, large character avatars with the name underneath, an unread
  dot on the avatar.
- **Groups:** a small muted heading per group (`fitness`, `dev stuff`, `news`), then one row per Bot:
  avatar, name, a one-line preview of the last message, an unread dot on the right.
- **Selected row:** a slightly lighter rounded background.
- **Bottom:** your photo and name, and an apps button.

[The sidebar: pinned Bots, groups, the selected row and unread dots.](screen:sidebar)

### Conversation

- **Header:** the Bot's avatar and name in a pill, centred, with the time below.
- **Your messages:** right-aligned, accent background, dark text (`--bg`, 4.5:1 or better), large radius.
- **Bot messages:** left-aligned, dark grey background, max ~60% width. A Bot's consecutive messages are
  separate bubbles stacked with a small gap, not one long block.
- **Rich text:** bold, bullet lists, line breaks render inside the bubble.
- **Approval card:** a grey card with the question in muted bold text and one or more answer rows, each
  with a lettered key (`A`, `B`) in an accent square. Choosing one sends it as your reply and writes an
  audit row.
- **Composer:** a full-width rounded bar at the bottom: `＋` for attachments, placeholder
  `Message <Bot name>`, a microphone button, and a round accent voice button. E0-1 builds the text-only
  version: the input and one round button, send or, while the Bot answers, stop.
- **Errors:** one line above the composer, in the danger colour, never a modal. The text says what to do next.

[A conversation: your bubble on the right, the Bot's on the left, two Bot bubbles stacked, a line break inside one.](screen:conversation)

[While the Bot answers: its text so far, and the composer shows stop in place of send.](screen:conversation-running)

[Before the Bot has loaded: the pill says "Connecting…" and the composer is off.](screen:connecting)

[The approval card inside the conversation: the question in muted bold, answers with lettered accent keys.](screen:approval-card)

**Composer states.**

[Idle: the placeholder names the Bot. Type to enable send.](screen:composer-idle)

[Focused: an accent outline.](screen:composer-focused)

[The Bot is answering: stop replaces send.](screen:composer-running)

[Disabled: no Bot loaded yet, so nothing can be sent.](screen:composer-disabled)

**Error states.**

[The socket dropped or the server is down.](screen:error-connection)

[A second message while the Bot is still answering is refused and its bubble taken back.](screen:error-busy)

[The model sent nothing for 60 seconds, so the turn was stopped.](screen:error-stalled)

### Bot avatars

Each Bot gets a simple, friendly character: a soft blob shape in one solid colour with two eyes. Colour
and shape tell Bots apart at a glance. Make our own set (Codex generates the images); do not copy the
characters from the reference.

[The planned set: eight characters, each one solid colour and a pair of eyes.](screen:avatars)

## Tokens (starting point)

| Token          | Value                                          | Use                                     |
| -------------- | ---------------------------------------------- | --------------------------------------- |
| `--bg`         | `#0f0f10`                                      | app background                          |
| `--sidebar`    | `#141415`                                      | sidebar                                 |
| `--bubble`     | `#1f1f21`                                      | Bot bubbles, cards, composer            |
| `--row-active` | `#232325`                                      | selected sidebar row                    |
| `--fg`         | `#ececed`                                      | text                                    |
| `--muted`      | `#8a8a8f`                                      | previews, group headings, times         |
| `--accent`     | `#3fa592`                                      | your bubbles, voice button, answer keys |
| `--unread`     | `#3b82f6`                                      | unread dots                             |
| radius         | 18px bubbles, 12px rows, full for icon buttons |                                         |
| font           | system sans, 15–16px body                      |                                         |

Dark is the main theme. A light theme is a later ticket.

## Where this lands in the backlog

| Ticket                                                                              | Design work                                     |
| ----------------------------------------------------------------------------------- | ----------------------------------------------- |
| [E0-1](backlog/E0-walking-skeleton/E0-1-chat-with-a-bot-locally.md)                 | Tokens, conversation view, composer (text only) |
| [E1-4](backlog/E1-a-computer/E1-4-watch-the-live-screen.md)                         | Live screen as a side panel                     |
| [E2-1](backlog/E2-roles-and-guardrails/E2-1-bots-from-a-file-with-granted-tools.md) | Sidebar with groups, pinned Bots, avatars       |
| [E2-5](backlog/E2-roles-and-guardrails/E2-5-ask-before-risky-actions.md)            | Approval card                                   |
| [E3-2](backlog/E3-people/E3-2-my-conversations-only-mine.md)                        | Last-message previews and unread dots           |
