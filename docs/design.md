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
  "Message <Bot name>", a microphone button, and a round accent voice button.

### Bot avatars

Each Bot gets a simple, friendly character: a soft blob shape in one solid colour with two eyes. Colour
and shape tell Bots apart at a glance. Make our own set (Codex generates the images); do not copy the
characters from the reference.

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
