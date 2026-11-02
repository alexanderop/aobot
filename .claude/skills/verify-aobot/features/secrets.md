# Secrets

Nothing a Bot typed and no password a person gave it is kept in the chat, the audit trail or telemetry.
A Bot asks for a password with `request_secret`; the transcript shows a secret card with the field the
Bot named on the host the server read, a password input, Supply and Decline, once the server streams the
request over `Secret.pending`. An answer names that request's id. What the person supplies goes straight to the computer,
which types it into the field and shows its value as `"[hidden]"` in every later read of the page. Audit
rows keep a typed text's length, an address without its query values or fragment, and a command without
the secrets in it.

## Sub-features

- `secrets-typed` Assistant types into a search box: `type · allow` keeps `"text":"[N chars]"`.
- `secrets-request` Assistant calls `request_secret({ ref, field })`: a card `data-tool="request_secret"`
  saying `Asks for <field> on <host>` with `input[type="password"]`; `secret.requested · allow` names the
  field and the element. A ref that is no `textbox` or `searchbox` is `secret.requested · deny` with
  `reason: "not a text field"`, and one on a page on no site, such as `about:blank`, with
  `reason: "no site"`.
- `secrets-supply` the person types and presses Supply: the card says `Supplied <field>`, the call's
  result shows `textbox "Password" … : "[hidden]"`, `secret.supplied · allow` keeps `chars` only.
- `secrets-decline` Decline: the call fails with `Your person declined …`; `secret.requested · failed`
  with `reason: "declined"`.
- `secrets-masked` a password, one-time code or marked field never shows its value in a snapshot, even
  one the Bot typed itself.
- `secrets-redacted` `navigate` rows lose query values and the fragment; `run` rows lose
  `API_TOKEN=…`, `--password …`, `-H "Authorization: …"`, `"password":"…"`, `mysql -p…` values. The
  model reads a page's URL with only credential-named query values and the fragment's values redacted.

## How to get to it (user POV)

- Open http://localhost:3100 with Assistant selected and ask it to sign in to a page; when it asks, type
  the password into the card in the transcript.

## Driving it with stack.sh

Preconditions: baseline. The fixture serves `http://fixture:8080/search` and `/login` (password in
`verify/login.ts`).

- **Supply.** Script `navigate` to `http://fixture:8080/login`, then
  `request_secret` with `{"ref":{"$refTo":{"role":"textbox","name":"Password"}},"field":"the password"}`,
  then a `Say`. Send a message, `$S ab wait '.tool-call[data-tool="request_secret"] input[type="password"]'`,
  `$S ab fill '.tool-call[data-tool="request_secret"] input[type="password"]' <password>`,
  `$S ab click '.tool-call[data-tool="request_secret"] button[type="submit"]'`. `$S audit` shows
  `secret.requested · allow`, `· succeeded`, `secret.supplied · allow`, `· succeeded`.
- **Decline.** The same, then `$S ab find role button click --name Decline`.

## Gotchas

- `vp run verify E2-3` is the scripted proof, and searches the SQLite files, Tempo, both logs and the
  mock model's requests for both secrets.
- The request waits ten minutes at most. Under `acp` the stall limit waits while the CLI's tool call
  runs, and Claude Code is started with a longer MCP idle timeout; Codex ends the call after its own
  default, about two minutes (see docs/architecture.md § Secrets).
- A person's own message is stored as they wrote it: a secret typed into the composer is not protected.
