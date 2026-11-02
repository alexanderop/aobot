# Rules

Security writes deny and allow rules in the root `rules.yaml`, in CEL over the action's facts (tool, Bot,
person, computer, page host, element, key, command, file). After the grant, the door and the ref, every
Bot action is judged: deny rules first, then an allow rule must hold, and anything unclear is refused.
A refusal shows in the transcript, the model reads which rule refused it, and the audit row and the
`Gateway.act` span name the rule.

## Sub-features

- `rules-deny` Assistant asked to run `rm -rf /tmp/x`: the shipped `no-rm-rf` refuses it. One
  `run · deny` with `{ "bot": "assistant", "command": "rm -rf /tmp/x", "rule": "no-rm-rf", "reason": "denied by rule" }`,
  no allow row, the computer never starts.
- `rules-allow` any other granted action: its `allow` row ends with `"rule": "granted-tools"`.
- `rules-span` the turn's `Gateway.act` span has `gateway.decision` (`allow` or `deny`) and
  `gateway.rule` when a rule decided.
- `rules-press` Assistant presses a key by ref (`press`, `{ ref, key }`): a rule can name `key` and the
  `page.host` of the page the latest snapshot read.
- `rules-invalid` a `rules.yaml` that is not valid stops the server with the reason.

## How to get to it (user POV)

- Open http://localhost:3100 with Assistant selected and ask it to run a command a deny rule names.

## Driving it with stack.sh

Preconditions: baseline.

- **Deny.** `echo '[{"_tag":"CallTools","calls":[{"name":"run","params":{"command":"rm -rf /tmp/x"}}]},{"_tag":"Say","words":["Refused."]}]' | $S script`,
  fill `Message Assistant`, Enter, `$S wait-answer 1 "Refused." 90`. The run card is `data-status="failed"`
  and reads `run did not run: the rule no-rm-rf refuses it.` `$S audit` holds one row, `run · deny`.
  `$S trace <trace_id>` shows `gateway.decision=deny` and `gateway.rule=no-rm-rf` on `Gateway.act`.
- **Allow.** Script `run` with `ls`: `$S audit` shows `run · allow` whose detail ends `"rule":"granted-tools"`.
- **Invalid file.** Not on this stack (it mounts the root file). On the host:
  `RULES_FILE=/tmp/bad.yaml node apps/server/src/app/main.ts` with a rule `when: tool.nam == "run"` exits 1
  with `RulesFileInvalid: … is not a valid rules file: No such key: nam at ["deny"][0]["when"]`.

## Gotchas

- `vp run verify E2-2` is the scripted proof of `rules-deny` and `rules-span`.
- The server reads `rules.yaml` once at start-up. After editing it, restart the server
  (`docker compose restart server`); no rebuild.
- In YAML, `when: "true"` is the CEL `true`. A CEL string literal needs both quotes: `when: '"x" == command'`.
- A failed rule's error (which can echo the command) is only in the deny row's `error`, never in a log or span.
