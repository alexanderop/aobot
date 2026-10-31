---
id: E4-4
title: My Bot uses Chrome on my Mac
epic: E4
status: todo
depends_on: [E4-3, E1-2]
estimate: 3d
---

# E4-4 · My Bot uses Chrome on my Mac

**Story:** As a colleague, my Bot can use a browser window on my Mac for sites that only work from my machine, and I see it happen on my own screen.

## Scope

In:

- The desktop app starts the installed Google Chrome with an aobot-owned profile per Bot under
  `~/Library/Application Support/aobot/`, never the person's own Chrome profile
- The same browser tools as the cloud computer (`navigate`, `snapshot`, `click`, `type`) with `computer: "mac"`,
  driven over a pipe, with no TCP debugging port opened
- The same governance: grant, rules, audit, untrusted snapshots, secrets through `request_secret`
- Take control is just using the window; the Bot is refused while the window has the person's focus and
  input, and resumes on "Hand back"

Out:

- Using the person's own logged-in profile (never)
- Full Mac control: other apps, mouse and keyboard outside Chrome (later, needs Accessibility permission)

## Demo

1. Ask: "Open the intranet page on my Mac and tell me its title."
2. A Chrome window opens on the desk; the Bot answers with the title.
3. The audit rows say `computer=mac`.

## Layers

desktop · server · gateway

## Audit

`navigate · allow · computer=mac`, `snapshot · allow · computer=mac`.

## Telemetry

`computer.kind` on spans.

## Tests

- Tier 3: the browser part of the contract suite against `mac`.
- Tier 4: the demo against a local fixture page.

## Reference

OpenBot `docs/configuration.md` § Installed Chrome for a local API deployment and § OpenBot Desktop runs it for the person.
