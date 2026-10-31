---
title: E4 · Desktop app
description: "Electron wraps the web app and adds what a browser tab cannot: safe token storage and notifications."
---

# E4 · Desktop app

Electron wraps the web app and adds what a browser tab cannot: safe token storage and notifications.

**Epic demo:** A colleague installs the app, signs in once, gets a notification when their Bot needs help, and lets the Bot work in a folder and a browser on their Mac next to its cloud computer.

| Ticket                                             | Title                              | Depends on | Estimate |
| -------------------------------------------------- | ---------------------------------- | ---------- | -------- |
| [E4-1](E4-1-the-desktop-app.md)                    | The desktop app                    | E3-1       | 3d       |
| [E4-2](E4-2-tell-me-when-my-bot-needs-help.md)     | Tell me when my Bot needs help     | E4-1, E1-5 | 2d       |
| [E4-3](E4-3-my-bot-works-in-a-folder-on-my-mac.md) | My Bot works in a folder on my Mac | E4-1, E2-5 | 4d       |
| [E4-4](E4-4-my-bot-uses-chrome-on-my-mac.md)       | My Bot uses Chrome on my Mac       | E4-3, E1-2 | 3d       |
