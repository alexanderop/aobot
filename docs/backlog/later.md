# Later

Not planned yet. Each becomes an epic when the core above is in use.

| Idea                       | What it is                                                                       | Reference in OpenBot                              |
| -------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------- |
| Generative UI              | Bots answer with charts, tables and cards instead of only text                   | Components gallery, `app/src/components/gallery/` |
| Bot-to-Bot handoff         | A Bot asks another Bot, under a grant, audited with the asking Bot as the cause  | Groups and handoffs in `docs/architecture.md`     |
| Routines                   | Scheduled turns that run as their owner; audit marks them as "nobody watching"   | `docs/routines.md`                                |
| App integrations           | MCP tools from Composio, Arcade or our own servers, granted per Bot and per tool | `docs/plugins/`                                   |
| Bots and rules in the UI   | Admins create Bots and edit rules without a deploy                               | `/bots`, admin policy                             |
| Memory                     | Facts a Bot keeps about a person across conversations                            | `server/src/memory/`                              |
| Recorder                   | Learn a workflow from a person's own browser in the desktop app                  | `extension/`, OpenBot Recorder                    |
| Audit export and retention | CSV export, retention period, deletion                                           | `docs/architecture.md` § Taking the trail out     |
