---
title: 12. Glossary
description: The words aobot uses, and what each one means in the code.
---

# 12. Glossary

| Term                  | Meaning                                                                                                                                                   | In the code                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Bot**               | An AI coworker with a role: a name, instructions, and the tools it is granted. A person picks one to talk to                                              | `Bot`, `BotId`, `BotSummary`; `features/bots`                 |
| **Person**            | A human using aobot. Today there is exactly one, unnamed; sign-in arrives with E3-1                                                                       | (planned) `PersonId`                                          |
| **Conversation**      | The messages between one person and one Bot, in order. The page picks its id and keeps it in the URL. AG-UI calls it a thread                             | `ConversationId`, `ConversationStore`; `threadId` on the wire |
| **Message**           | One thing the person or the Bot said, with a `role` of `user` or `assistant`                                                                              | `Message`, `MessageId`                                        |
| **Turn / Run**        | One round from the person's message to the Bot's last word. "Turn" is the agent's view, "run" is AG-UI's. At most one runs per conversation               | `Turn`, `RunId`, `turnEvents`                                 |
| **Step**              | One model call inside a turn. A step that calls tools leads to another, up to the step cap                                                                | `AGENT_MAX_STEPS`, `StepLimit`                                |
| **AgentRuntime**      | The service that runs the think-act loop for a turn. `api` uses `effect/ai` with an API key; `acp` drives the person's own CLI                            | `AgentRuntime`, `layerApi`                                    |
| **Model provider**    | The API the `api` runtime talks to: `anthropic`, `openai` or `openai-compat`                                                                              | `ModelProvider`, `modelProviders`                             |
| **ChatEvent / AG-UI** | One event in a streamed turn. AG-UI is the open event protocol (`@ag-ui/core` 1.0.2) whose names and fields `ChatEvent` copies                            | `ChatEvent`, `RunErrorCode`                                   |
| **ChatRpcs**          | The chat API the server serves and the page calls over one WebSocket: `Chat.open`, `Chat.send`, `Chat.stop`                                               | `ChatRpcs`                                                    |
| **Computer**          | A Bot's own machine: Chromium, bash and a `/workspace` folder in a container, or the person's Mac. Reached only as a URL and a token                      | (planned) `Computers`, `apps/computer`                        |
| **Gateway**           | The one door between the agent and a computer. It checks the grant, then the rules, writes an audit row, and only then forwards                           | (planned) `features/gateway`                                  |
| **Tool**              | An action a Bot may ask for, such as `navigate` or `run`. Every tool is a gateway tool                                                                    | `Toolkit` (empty today)                                       |
| **Grant**             | Permission in a Bot's role to use one tool. No grant, no call: refused before any rule runs                                                               | (planned) E2-1                                                |
| **Rule**              | A deny or allow decision over tool, page, command and Bot. Rules fail closed: missing permits nothing, crashing denies                                    | (planned) `features/policy`, E2-2                             |
| **Audit row**         | The record of one gateway decision: what, for whom, who initiated it, allowed or refused, and the `trace_id`. Append-only, with what a Bot typed redacted | (planned) `features/audit`, E2-4                              |
| **Initiator**         | Who started an action: `person` or `deployment` now, `routine` and `handoff` later                                                                        | (planned) `initiator_kind`                                    |
| **Approval**          | A yes or no the person gives in the chat before a risky action. Bound to that exact action and spent once                                                 | (planned) `features/approvals`, E2-5                          |
| **Snapshot**          | The page as text: its accessibility tree with a ref per element, capped at 12,000 characters                                                              | (planned) E1-1                                                |
| **Ticket / Epic**     | A ticket is one vertical slice with a demo. An epic is a group of tickets that ends in a bigger demo                                                      | `docs/backlog/`                                               |
