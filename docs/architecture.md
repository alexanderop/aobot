# Architecture

## What aobot is

A chatbot answers. A coworker acts: it opens pages, fills in forms, runs scripts. aobot gives each Bot
three things:

|                | What it means                                                              | Where it lives                  |
| -------------- | -------------------------------------------------------------------------- | ------------------------------- |
| **A role**     | A name, instructions, and the tools it is granted                          | `bots.yaml`, later the admin UI |
| **A computer** | Its own Chromium, bash and `/workspace`, in a container                    | `apps/computer`                 |
| **Guardrails** | Grants, rules that fail closed, an audit trail, a person who can take over | `apps/server` gateway           |

## The five parts

```
 Desktop app / web page ──► Server ──► Agent runtime (`api`: effect/ai · `acp`: your own CLI)
                              ▲              │ tool call
                              │              ▼
                              └──── Gateway: granted? → the person's? → rules? → audit row → forward
                                                                   │
                                                                   ▼
                                                 Computer (container: Chromium, bash, /workspace)
```

| Part                | Its one job                                                            | Built with                   |
| ------------------- | ---------------------------------------------------------------------- | ---------------------------- |
| `apps/web`          | Show the conversation and the live screen, let a person take the mouse | React + `@effect/atom-react` |
| `apps/desktop`      | Wrap `apps/web`, keep the sign-in token safe, send notifications       | Electron                     |
| `apps/server`       | Know Bots and people, run agent turns, stream answers                  | Effect on Node               |
| Gateway (in server) | Decide if a tool call may happen, record it, then forward it           | Effect service + SQLite      |
| `apps/computer`     | Actually do it: browse, click, type, run commands                      | Node + Playwright in Docker  |
| `packages/domain`   | Schemas shared by all of the above: Bot, ToolCall, AuditRow, ChatEvent | Effect Schema                |

### Inside each app: features

Each app is split by feature, not by technical layer: `src/app` wires things together,
`src/features/<feature>` holds one capability end to end with `public.ts` as its only entry point, and
`src/shared` holds generic helpers. Which feature may use which is declared in
`tools/oxlint/aobot-architecture/policy.ts` and enforced by oxlint. See
[quality-gates.md § Feature-based architecture](quality-gates.md#feature-based-architecture).

The agent never talks to a computer directly. It can only ask, and the gateway answers. The feature graph
enforces this: only the `gateway` feature may depend on `computers`.

## Agent runtimes

The think-act loop is a provider, like a computer. One `AgentRuntime` service, two implementations,
chosen by `AGENT_RUNTIME`:

| Runtime | Where              | Model and billing                                                                 | How tools reach the gateway                                                                                    |
| ------- | ------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `api`   | Cloud, and locally | Any provider with an API key: Anthropic, OpenAI, OpenAI-compatible, OpenRouter    | `effect/ai` `LanguageModel` with our own loop. The `Toolkit` handlers _are_ the gateway; there is nothing else |
| `acp`   | Laptop only        | The person's own subscription: Claude Code, Codex or OpenCode, spoken to over ACP | Our tools offered as one MCP server in `session/new`. Built-in tools are switched off                          |

Whatever the runtime, the only tools a Bot has are gateway tools. For `acp` that is not the default, so it is
enforced three ways:

1. The CLI is started with its own tools switched off and only the gateway MCP server offered.
2. Every `session/request_permission` and every client-side `fs/*` or `terminal/*` request is refused unless
   it names a gateway tool, and the refusal is an audit row.
3. The agent runtime contract suite asks each CLI, through the scripted model, to run a shell command and
   read a file outside the gateway. Both must fail. A CLI that fails the suite is not supported.

`acp` runs on one person's subscription, so it is refused at start-up unless single-user mode is on and the
server listens on loopback. A subscription is never shared between people and never runs in the cloud.

## Two computers: the cloud one and your Mac

A Bot always has its cloud computer. While the desktop app is open and signed in, it can also use the
person's own Mac. Every computer tool takes a `computer` argument, `cloud` or `mac`, and rules see it as
`computer.kind`.

|                   | Cloud computer                               | Your Mac                                                                                           |
| ----------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Exists            | Always; started on demand, stopped when idle | Only while the desktop app is open and signed in as its owner                                      |
| How it is reached | The server calls it: "a URL and a token"     | The desktop app connects out to the server and pulls work; the server never dials a laptop         |
| Files             | `/workspace`                                 | Only folders the person picked in the macOS folder dialog, one grant per Bot, revocable            |
| Shell             | `bash` in the container                      | Per command, a native "Allow?" dialog by default, run in a sandbox without network                 |
| Browser           | The Bot's Chromium                           | The person's installed Chrome with a separate aobot profile, never their own profile               |
| Who may use it    | The Bots of the person it belongs to         | The Bots of the signed-in owner only, never another person's, never a routine with nobody watching |

The gateway is still the only door: grant, rules, audit row, then forward. The Mac adds a second check on
the Mac itself, the native dialog, because a rule written on the server cannot see what is on the
person's disk. When the app is closed, a `mac` call fails with "your Mac is not connected" rather than
waiting.

## Bots and their grants

An admin defines the Bots in `bots.yaml` at the repository root (`BOTS_FILE` points elsewhere; Compose
mounts it into the server). Each Bot has an id, a name, its instructions, the tools it is granted, and
where the sidebar shows it: `pinned`, or under a `group`.

```yaml
bots:
  - id: researcher # lowercase letters, digits and dashes
    name: Researcher
    group: research
    instructions: You are Researcher. You look things up on the web and report what you found.
    tools: [snapshot, navigate, click]
```

The server decodes the file with Effect Schema once at start-up. A file that is missing, empty or not
YAML, misses a field or misspells one, names a tool that does not exist, pins a Bot it also puts in a
group, gives two Bots one id, or lists no Bot at all stops the server with the file's path, every
problem in it and where in the file each is. An edit takes effect on the next start.

Every Bot is offered every gateway tool, whichever runtime runs it, because the gateway is what enforces
the grant: a model that calls a tool its Bot was not granted reads why. Its instructions describe only
the tools it was granted, so a model rarely tries the others.

Each turn runs on behalf of one Bot. The `api` runtime provides the turn's Bot to the tool handlers as
`ActingBot`; the `acp` runtime offers the gateway's MCP server with an `aobot-bot` header naming it, and
the server reads `ActingBot` from that header on every call.

`Gateway.act` checks the grant before anything else the gateway does: before the door, before a ref is
resolved or a path judged, and before any rule. Only the toolkit comes first, decoding the call's
parameters, and then the check that the turn the call names still runs (§ Stopping and pausing a Bot).
A tool the Bot was not granted, a Bot the file does not name, and a call that names no Bot are each a
`deny` row with `{ bot, reason: "not granted to <bot id>" }` (`an unnamed Bot` when it names none, and
the header quoted as written when an `acp` CLI's `aobot-bot` header is no Bot id), the computer never
hears of it, and the model reads:

> run did not run: it is not granted to researcher. Use only the tools your instructions name.

## Rules that fail closed

Security writes deny, allow and ask rules in `rules.yaml` at the repository root (`RULES_FILE` points
elsewhere; Compose mounts it into the server next to `bots.yaml`). The grant decides which tools a Bot
has; the rules narrow what it may do with them. Each rule has a name, which the audit row and the model's
answer give, and a `when` in [CEL](https://cel.dev), through `@marcbachmann/cel-js`.

```yaml
deny:
  - name: no-rm-rf # lowercase letters, digits and dashes, unique across every list
    when: tool.name == "run" && command.contains("rm -rf")
allow:
  - name: granted-tools
    when: "true"
ask: # optional
  - name: ask-before-delete
    when: tool.name == "run" && command.contains("delete")
```

A rule reads one record of facts about the action, declared once in `features/policy/facts.ts`, where the
CEL environment is built from the same declaration so the two cannot drift:

| Field                                      | What it holds                                                                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `tool.name`                                | The tool: `navigate`, `snapshot`, `click`, `type`, `press`, `run`, `read_file`, `write_file`, `list_files`, `request_secret` |
| `bot.id`                                   | The Bot the call is for                                                                                                      |
| `actor.id`                                 | The person whose turn it is, by their email address; `single-user` in single-user mode                                       |
| `computer.kind`                            | `cloud`; `mac` arrives with the Mac                                                                                          |
| `page.host`                                | For `navigate`, the host it opens; for the other browser tools, the host of the page the latest snapshot read                |
| `element.role`, `element.name`             | The element a ref names in the server's own snapshot, never what the Bot says it is                                          |
| `key`                                      | The key `press` presses                                                                                                      |
| `command`                                  | The command `run` runs, as the Bot wrote it                                                                                  |
| `file.path`, `file.name`, `file.extension` | The file a file tool names, as its audit row records it                                                                      |

Every field is bound on every action, `""` where the action has none, so a rule naming `element.name`
answers false for `run` instead of failing. `page.host` is the host in the one spelling the computer's
egress checks it in (`canonicalHost` in `@aobot/domain`): lower-cased, without its port, brackets or a
trailing dot, so `SHOP.example.` and `shop.example%2e` are `shop.example` and `[::1]` is `::1`. It is the
host of the page's origin, so `blob:https://shop.example/…` is `shop.example`, the site the computer's
`sameOrigin` counts it on, and `""` for an address that does not parse or whose origin is opaque, such as
`about:blank` or a `data:` page. The latest snapshot keeps the address it was read at for this. A snapshot
stored before E2-2 has none, so the migration that adds the address forgets it rather than let a ref be
judged on the host `""`: no ref resolves until a Bot reads the page again.

The order in `Gateway.act` is grant, door, ref or path, safety list, rules, `allow` row, forward. A ref
that does not resolve is refused for that and never judged on an empty element. An action on the safety
list is handed to the person before any rule is read (see [Actions that are always the
person's](#actions-that-are-always-the-persons)). Then every deny rule in the order the file gives
them: the first that holds refuses. Then every allow rule in order: the first that holds allows.
Anything no allow rule allows is refused, so empty lists refuse everything; the server logs a warning
at start-up when the allow list is empty. Then every ask rule in order: the first that holds asks the
person first (see [Asking the person](#asking-the-person)). An ask rule is read only for an action an
allow rule allowed, so adding one never allows anything, and every action that runs is still allowed by
an allow rule.

It fails closed. A deny rule that fails while it is evaluated, such as
`command == "" || int(command) > 0` on `ls`, refuses. An allow rule that fails allows nothing, and a
later allow rule still can. An ask rule that fails asks the person. A failed rule is logged by its name
and list only, never its error, which can echo what the action holds. The error goes into the action's
deny row, capped: a failed deny rule's as `error`, and when nothing allowed the action, each failed allow
rule's as `failed: [{ rule, error }]`. When a later allow rule allows the action anyway, the errors of the allow rules that failed before it are
not kept; only their warnings are. A file that is missing, empty or not YAML, misses a list or misspells
a key, gives a name that is not a slug or names two rules, or has a `when` that does not parse, names a
field the facts do not have, does not answer `bool` (a `dyn` answer included), calls `matches`, or fails
when `page.host`, `element`, `key`, `command` and `file` are `""` (such as `int("ten")`, `1/0` or
`command.split(" ")[1]`) stops the server with the path, every problem and where in the file each is.
Each rule is tried once on those blank facts when the file is read, which catches a rule that fails on an
action without the fact it reads. A rule that fails only on some actions, such as
`command == "" || int(command) > 0` on `ls`, still loads, and fails closed each time it runs. The facts every action has
hold a value they can have in that try: `bot.id` is `bot`, `actor.id` is `single-user` and
`computer.kind` is `cloud`, so `computer.kind.substring(0, 3) == "clo"` loads, since none of them is ever
`""` on a real action. `matches` is refused because cel-js runs it as a backtracking JavaScript regular
expression on the server's one thread, where `^(a+)+$` on a short command holds every turn for seconds;
write the rule with `contains`, `startsWith`, `endsWith` and `lowerAscii()` instead. That does not make
every rule cheap: a comprehension over `command.split("")` is quadratic in the command's length, so keep
rules simple.

A refusal is a `deny` row with the action's audit detail and the rule: `run · deny · no-rm-rf` is
`{ bot, command, rule: "no-rm-rf", reason: "denied by rule" }`, a failed deny rule adds `error` with
`reason: "rule failed"`, and nothing allowed is `{ rule: null, reason: "no rule allows it" }`, with
`failed` when an allow rule failed. An `allow` row names the allow rule that allowed it as `rule`. The
`Gateway.act` span records `gateway.decision` (`allow` or `deny`, for every refusal) and `gateway.rule`
when a rule decided. The model reads:

> run did not run: the rule no-rm-rf refuses it. Tell your person what was refused; do not try another way around it.

`press` activates the element it targets: Space or Enter on a button clicks it, and Enter in a field
submits its form. So a rule that must stop a submission names `click` and `press` on the button, and
Enter in the form's fields: `tool.name in ["click", "press"] && element.name == "Submit"` and
`tool.name == "press" && key == "Enter" && page.host == "shop.example"`. Matching a command's text is a
filter, not a boundary; the computer the command runs on is the boundary.

Known gaps. `page.host` is the host of the page an action acts on, never of the page it lands on. So
`snapshot` is judged on the page the last Bot action read, or on `""` after a hand-back, while the
browser may show another page by then: one the person opened while they held the computer, or one the
page moved to by itself. A click that follows a link, Enter that submits a form, and a redirect after
`navigate` all reach a host no rule judged; the egress filter still decides whether the computer may go
there at all. Judging the page an action lands on is a follow-up (`docs/backlog/later.md`).

## Actions that are always the person's

A Bot never enters or changes a credential, changes a security setting, or pays, whatever `rules.yaml`
says. The safety list is code, in `gateway/safety.ts`, not configuration: no rule, no admin setting and
no yes to an ask rule turns it off. It has three lists, matched in order: `credentials` (a password,
passcode, PIN, one-time, verification or security code, a card's included, a code a page asks to enter, a
security question), `security` (two-factor and 2-step sign-in, passkeys, authenticator apps, recovery
codes, API keys, access tokens and SSH keys, revoking sessions, changing the account's email, making an
admin, inviting people, changing a role, transferring ownership, authorizing an app or allowing it
access, security, sharing and permission settings, deleting, closing or deactivating the account) and
`payments` (paying, checkout, buying, ordering, completing or confirming an order, booking now,
subscribing and upgrading a plan, adding or changing a card, card numbers and expiry dates, bank
accounts, wires, transfers, a send page, withdrawals and donations, billing). Each also matches its
German words for a password, two-factor sign-in, deleting the account, changing its email, buying,
ordering, paying, subscribing, transfers and a card's fields.

**What it reads.** A `click`, `type` or `press` is matched on the element its ref resolved to, as
the server's snapshot names it (role and name), and the host and path of the page that snapshot was
read at, so a "Continue" button on `/checkout` is a payment. It matches them as a person reads them:
full-width letters folded, soft hyphens and zero-width characters dropped, typographic dashes made
plain, and the path's percent-escapes decoded, so `/%C3%BCberweisung` is a transfer. Never on the
text a Bot types or the key it presses: a note about a customer's purchase is not a purchase. Never
on the address's query or fragment, which the latest snapshot does not keep. A snapshot stored
before E2-6 has no path, so the migration that adds it forgets the snapshot, as the one that added
its address did. The lists are deliberately broad: a false hand-off costs the person one click, a
missed one costs them their account or their money.

**What it misses.** It reads the path and never the query or fragment, so on a page routed by them,
such as `/#/settings/password` or `index.php?page=checkout`, it rests on the element's name alone.
Enter pressed in a field named like a password hands off even on a sign-in page, so a Bot signs in by
clicking the page's button; that false hand-off costs one click. The path it judges is the one the
latest snapshot read, so a page that navigates by itself after that read is judged by its old path
until the next snapshot.

**What it does not read.** `navigate` and `snapshot` only read a page, and reading a checkout page is not
paying. `run` and the file tools are workspace tools, left to the rules: a command's text is a filter,
not a boundary, and the egress filter decides where it may reach. `request_secret` is the person typing
the secret themselves, on a card that names the field and the site; the click or key that submits it is
judged like any other, so "Change password" is still the person's.

**A match hands the action to the person.** It runs after the grant, the door and the ref, and before any
rule, so a deny rule never refuses it and an ask rule never asks about it. The computer never hears of it.
It is one `hand_off` row, a decision no outcome follows, with the action's audit detail, the page's
`path` and the list as `safety`: `click · hand_off · safety:credentials` is
`{ bot, ref, role, name, host, path, safety: "credentials" }`. The audit page reads it as "Handed to the
person" and shows `safety:credentials` where another row shows its rule. The `Gateway.act` span records
`gateway.decision=hand_off`, `decision.source=safety` and `gateway.safety`. The model reads:

> click did not run: entering or changing a password, PIN, one-time code or other credential is always your person's to do, never a Bot's, whatever the rules say. Stop, tell your person what needs doing, and ask them to take control of your computer and do it themselves.

The person does it on the live screen ([Taking control](#taking-control)). An action the person said yes
to is matched again when it runs, since the page can have moved on to one where the same element is
theirs; then the `hand_off` row closes the question, naming the approval and, as `rule`, the ask rule
the person was asked under. The audit page still shows the list there, as `safety:security`.

## Life of one request

1. A person signed in sends a message with the Bot they picked.
2. The server starts an agent turn on behalf of that Bot and that person, once `Turns.start` read that
   the Bot is not paused, with its instructions, which name the tools it was granted.
3. The agent asks for a tool, for example `navigate`.
4. The gateway checks that the turn still runs, then the grant, then that the turn is a person's, then
   the safety list, then the rules, and writes one audit row either way, naming that person. When an ask rule holds, it asks the person in the chat first and
   waits for their answer.
5. Only on "yes", the gateway asks the person's computer to act, and never when its row could not be
   written. Every `allow` row then gets exactly one outcome row, `succeeded`, `failed` or `unknown`, so
   "allowed" never reads as "done". `unknown` means the server lost track, by a timeout or a restart; such a
   call is never run again, and a row left without an outcome by a crash is marked `unknown` at start-up.
6. The computer returns the page as text: the accessibility tree, with a ref per element.
7. The gateway wraps it as untrusted data (decision 10) before the agent sees it.
8. The agent reads it and decides the next step. Every step goes through the same door.
9. The answer streams back to the page, with each tool call shown between the text.

## Signing in

People sign in with their company account over OIDC; aobot keeps no passwords. The `auth` feature owns
who a request is for, and the rest of the server learns it from one place.

**Who acts.** `Actor` in `shared/actor.ts` is a `Person` (signed in, by email address), the `SingleUser`
of a server in single-user mode, a `Visitor` refused at sign-in, or the `Deployment`, the server acting
on its own. `CurrentActor` is a `Context.Reference` that defaults to the deployment. Audit rows read it
when they are written, the rules read it as `actor.id`, and `Chat.turn` records it, each spelt by
`actorId`, so nothing passes a person around by hand and a row written outside any request is the
server's own.

**Every request.** A global HTTP middleware in front of every route resolves the session cookie and runs
the route with `CurrentActor` set, so a route added later is covered without a line of its own. Signed
out, only `/auth/*`, the web app's `/assets/*` and `/healthz` answer; opening any other page gets the web
app, which shows the sign-in screen, and anything else gets 401, the RPC socket's upgrade included. Every
RPC group carries the `SignedIn` middleware, which resolves the session again for each call from the
headers the socket was opened with and fails with `SignedOut`; `app/rpcs.test.ts` fails when a group
lacks it. A message can name a cookie of its own, but a token only counts once its session is found, so
it can only be one the client already holds. Nothing caches a session: every request and every call reads
the database, so a sign-out, a removal by another process, or a domain no longer allowed counts at the next
one. When the database does not answer, the request is refused with 503, never treated as signed out.

**A Bot acts for its turn's person.** `Turns.start` keeps the actor of the call that started the turn,
and the gateway reads it with the turn's liveness, so a call from the `api` runtime and one an `acp` CLI
makes over `/mcp`, which carries no cookie, act for the same person. A call that names no turn, or a turn
no person started, is refused as `no person to act for`, right after its grant. A Stop or a pause names
whoever pressed it, the pause check's stop the person whose turn it was, and an approval's answer row
whoever answered it.

**Signing in.** `GET /auth/sign-in?return=<path>` sends the browser to the provider with PKCE, state and
nonce, kept until it comes back in a ten-minute `aobot_signin` cookie on `/auth`. `GET /auth/callback` is
read as an address at `PUBLIC_URL`, never from `Host`, checks the state, trades the code for an ID token
through `openid-client` (only `provider.ts` imports it), and needs a verified email address in printable
ASCII, refusing any other as `unsupported_email`: only `A` to `Z` are lower-cased, so the Kelvin sign's
`Kate@` is never read as `kate@`. Then, in one
transaction, the address must be admitted, the person is recorded, made an admin when `ADMIN_EMAILS`
names them for the first time, and given a seven-day session: a random token in an HttpOnly, SameSite=Lax
`aobot_session` cookie, `Secure` when `PUBLIC_URL` is `https`, and only its SHA-256 in `sessions`. The
browser returns to the page it came from, never another site. `POST /auth/sign-out` ends the session.
`GET /auth/session` tells the page who it is open for, and the page mounts nothing that opens a socket
until it has read that. Every RPC client's socket hangs off that answer (`shared/rpc-protocol.ts`): it
opens only while someone is signed in and is built again when that changes, so a sign-out, a removal or
an expiry closes every socket and every atom on one waits instead of asking again. The page reads the
session every half minute, on focus, and whenever the server refuses a socket or answers a call
`SignedOut`; a browser cannot tell a 401 upgrade from a server it cannot reach, so only the session's
answer decides whether to keep knocking.

**Who may sign in.** One pure rule, `admission`: the address's domain is one of
`SIGNIN_ALLOWED_EMAIL_DOMAINS` exactly, and the address was not removed. It is read before a person is
recorded, so `mallory@other.com` leaves no row in `people`, again inside the transaction that makes the
session, and on every request, so removing a domain also ends its open sessions. Each sign-in writes
`auth.signed_in` and each refusal `auth.refused` with its reason, under the address that tried when the
provider vouched for one; the page shows the reason from one table of words in `@aobot/domain`. A grant
by configuration writes `auth.admin_granted` once; dropping someone from `ADMIN_EMAILS` writes nothing,
and naming them again writes it again. Being an admin grants nothing yet: roles come later, and anyone
signed in may pause a Bot and read the trail.

**Removing a person.** `vp run people:remove <email>` marks the address removed and deletes its sessions
in one transaction with `person.removed`, by the deployment. A running server refuses the person at their
next request or call; a stream they already have open, such as a running turn, runs until it ends. Their
next sign-in is refused as `removed`, and an address removed before it ever signed in is blocked too.
Stopping their computer waits for E3-3, since the computer is shared until then, and nothing they gave
the deployment is stored to retire: a secret goes straight to the computer.

**Single-user mode.** `SINGLE_USER=true` resolves every request to the one person and mounts no sign-in
routes. It is off unless set. At start-up the server looks up every address `PUBLIC_URL`'s host and the
`HOST` it listens on resolve to: a public one, or a name that does not resolve, stops it, and each
private one, such as `192.168.1.5`, is logged as a warning. Listening on every address, as the default
`HOST=0.0.0.0` does, warns too and names `HOST=127.0.0.1` as the way to keep it on this machine, so a
container still starts. It looks at the addresses, never at `NODE_ENV`. `acp` still needs it and a
loopback `HOST`.

**The local provider.** Compose runs Dex with `alice@example.com`, `bob@example.com` and
`mallory@other.com`, password `password`, and only `example.com` allowed, on the default network only, so a
Bot's computer cannot reach it. The browser reaches Dex at `localhost:5556` and the server at `dex:5556`:
`OIDC_ISSUER_INTERNAL_URL` sends the server's requests to the issuer there, while tokens are still checked
against `OIDC_ISSUER`. Both must use https unless they are on this machine, one rule in `settings.ts`
read on `shared/reach.ts`'s `onThisMachine`; the internal address may be plain HTTP also when the issuer
is, which the issuer may only be on this machine, as Dex is here.

## Reading the audit trail

Security reads the trail on the audit page at `/audit`, through `GET /audit/rows`. It takes `bot`,
`person`, `decision`, `from` and `to` (ISO instants in the years 0000 to 9999; `from` inclusive, `to`
exclusive), `limit` (1 to 200, 50 when unsaid) and `cursor`, each optional, and answers the rows newest
first with `next`, the cursor of the page after, when there is one. A row's Bot is its detail's `bot`, or,
for an outcome row, that of the `allow` row it follows. A row's person is its `actor_id`: an email
address, `single-user`, `deployment`, or `anonymous` for a sign-in refused before anyone was named. Like
`/files`, it answers only this server's own pages, and only someone signed in.

Rows are ordered by `created_at`, then `seq`, the order they were written in. Not by `id`: ids are random,
and an `allow` row and its outcome often share a millisecond, so the outcome could read as the earlier of
the two. The cursor is the last row's `created_at`, exactly as the column stores it, and its `seq`, as
base64url JSON, so the next page starts right after that row however many rows share its instant. Only
`AuditTrail` reads or writes a cursor. A cursor or a query the server cannot read is a 400 that says
which, never a 500. A CLI's call outside the gateway is refused with the Bot whose turn it was as its
detail's `bot`, so the Bot filter shows it.

Each action and decision has one label, in `packages/domain/src/audit.ts`. The server writes `action` as an
`AuditAction` from that list, so a new action does not compile until it has a label. A value the page has
no label for, such as one a newer server wrote, reads Unknown, never Allowed. With `GRAFANA_URL` set, each
row with a `trace_id` links to Grafana Explore on the Tempo data source, an hour either side of the row.

## Watching the screen

While a turn the page started is running and has called a tool, or while the person holds the Bot's
computer, the page opens the Bot's screen as a side panel and watches it. Folded, the panel is a rail
with one button, Take control. A page that joins a running turn keeps the panel folded, because it cannot see when
that turn ends. The screen goes through the gateway feature but not its audited tools: watching asks the
computer to do nothing, so it is not audited, and it never starts a computer.

1. The computer runs one `Page.startScreencast` on the Bot's page while anyone watches, and moves it to the
   new page when the browser replaces a closed one. It serves the frames on `GET /stream`, a WebSocket
   behind the same bearer token and the same refusal of callers on the computer itself as `/act`. A viewer
   that reads slowly skips frames.
2. The server holds one connection to `/stream`, shared by every viewer, dialled only once a computer it
   started answers. When the computer is replaced it dials the new one with its new token, and it hangs up
   a while after the last viewer leaves.
3. The page asks `Screen.watch` on its own socket to `/rpc` and draws the latest frame as an `<img>`.
   `Screen.watch` sends a `Screen`: a `Frame`, the base64 JPEG the computer sent, or `Blank` while no
   computer runs or answers, and before a new one paints. A viewer is first sent the screen as it is now.

The page never learns the computer's address or token. A frame shows whatever the Bot typed, so it never
goes into a log, a span or an audit row.

## Taking control

A person takes the mouse when their Bot reaches a login or a CAPTCHA, clicks on the live screen
themselves, and hands it back. While the person holds the computer, the panel stays open, and every Bot
action is refused. `ComputerControl` does it, from the same layer as `Gateway`, so a person's take and the
Bots' actions meet at one door. Every Bot shares the one computer until E3-3 gives each person their own,
so there is one door for all of them, and a person who holds the computer holds it for every Bot.

1. The computer has one door in the gateway, and every Bot action goes through it right after its grant
   is checked, in `Gateway.act`, whatever the tool and whichever Bot asks. The door is `Open` while the Bots
   hold the computer, `Closing` while a take waits, and `Held` while the person holds it. Only an open
   door lets an action in. Commands wait for each other outside the door, since they share one shell, so a
   command whose turn comes while the person holds the computer is refused, and a take never waits for
   one.
2. `Control.take` writes `control_taken · allow`, closes the door, stores the one row of
   `computer_control`, then waits for the actions the door already let in to finish. The page shows
   `Taking` meanwhile. Once the person holds the computer, the take starts it if none runs, and answers. A
   computer that does not start leaves the person holding it, and the page says why. Taking again while
   holding it changes nothing but starts the computer again.
3. `computer_control` is read at start-up, so a restart, even one in the middle of a take, leaves the
   person in control. No computer runs then: the panel says the computer is not showing a page and offers
   to start it, which takes control again.
4. While the door is not open, a Bot call is a `deny` row with `{ bot, reason: "a person has control" }`, the
   computer never hears of it, and the model reads:

   > navigate did not run: a person has control of your computer. Wait until they hand it back, then take
   > a snapshot.

5. `Control.click` sends a click to the computer's `POST /input` as fractions of the screen, only while
   the person holds it and only to a computer already running, within 15 seconds. The page reads the
   fractions off the frame it draws; only the computer knows its viewport, so only the computer turns
   them into pixels. The computer clicks only once the browser's last action has settled, even one whose
   caller stopped waiting for it, so a Bot action from a stopped turn never lands beside the person's
   click. A click the page holds up past 5 seconds fails, and the browser is free for the next action.
   A person's clicks are not audited: the rows around them say who held the computer.
6. `Control.handBack` writes `control_released · allow`, and in one transaction deletes the
   `computer_control` row, forgets the latest snapshot, since the person may have changed the
   page, and writes `succeeded`. Old refs are then refused like any ref without a snapshot, so a Bot reads
   the page again before it acts on an element.

`/rpc` refuses a request with 403, before any RPC, unless the host it was sent to, its `Host`, is
`localhost`, `127.0.0.1`, `[::1]` or the host of the server's `PUBLIC_URL`, and a page's `Origin`, when it sends one,
names that same host. A browser lets any page open a socket to any address, so without the `Origin` check
any site the person visits could take control. Without the `Host` check, a site that points its own name
at this machine (DNS rebinding) could, and it needs no `Origin` for it: a browser sends none with a
same-origin `GET`. A client that is no page sends no `Origin` and is let through to this machine's names,
unless a browser's `Sec-Fetch-Site` says another site sent it, as it does for a link or an `<img>` that
carries no `Origin`. The `/files` routes below are guarded the same way.

`control_taken` and `control_released` are `allow` rows with an outcome, so a crash in the middle of
either is swept to `unknown` at start-up like any other call. Their spans, `ComputerControl.take` and
`ComputerControl.handBack`, carry the events `control.door_closed` (with `control.in_flight`),
`control.taken` and `control.released`; a refused call adds `control.refused` to its `Gateway.act` span.

## Stopping and pausing a Bot

A person stops their Bot's turn with Stop. An admin pauses a Bot, and none of its turns runs anywhere
until they resume it; until roles arrive, anyone signed in may pause, and in single-user mode the person
is the admin. Both go through `Turns`, in the
`lifecycle` feature, which owns the turns this server runs.

1. Every turn starts through `Turns.start`, whoever asks for it: today `Chat.send`, later a routine or a
   hop from another Bot. It claims the conversation, one turn per conversation, then reads `bot_pauses`.
   A paused Bot is refused with `BotPaused` before anything is stored, and the page says "This Bot is
   paused." and puts the message back in the composer. The read is tried three times, 100 ms apart, and
   when none answers the turn is refused with `PauseUnknown`: a Bot that may be paused never starts on a
   guess. Either refusal writes `turn · deny` with `{ bot, reason }`, `bot paused` or
   `pause state unreadable`.
2. The claim comes before the read, so a pause stored after the read still finds the turn and stops it.
   No turn slips between the two.
3. Stop signals the turn running in its conversation, and the turn ends its model stream and its running
   tool call. It ends with `RUN_ERROR` `stopped`, keeps what the Bot said, and writes
   `turn.stopped · allow` with `reason: "stopped by the person"`, then its `succeeded`, naming whoever
   pressed Stop. The turn writes
   these rows itself, inside its `Chat.turn` trace, where the stop becomes its end: a Stop that lands
   after the Bot finished, while its reply is stored, writes nothing, and the turn ends with
   `RUN_FINISHED`. A turn refused at its start never ran, so a pause that lands between its claim and its
   read writes only the `turn · deny` row.
4. `Pause.pause` stores the Bot's row in `bot_pauses` and its `bot.paused` rows in one transaction, then
   stops every turn of that Bot on this server at once, in one uninterruptible step, so a stored pause
   has always stopped them. Each ends with `RUN_ERROR` `paused`, "This Bot is paused.", and a `turn.stopped`
   row naming `bot paused` by the `person`. `Pause.resume` deletes the row with its `bot.resumed` rows.
   Pausing a paused Bot or resuming a running one writes nothing.
5. Every five seconds, on a fixed cadence, each server reads `bot_pauses` and stops its turns of every
   Bot paused on another server, among the turns that ran when it read: a turn that started meanwhile
   did a read of its own. Their `turn.stopped` rows are by the `deployment`. When three reads in a row
   fail while a Bot has a turn running here, its turns stop too, with `pause_unknown`: one slow query
   does not stop every running turn, fifteen seconds of a database that stays unreadable does. A read
   that answers, a turn's start among them, clears the count. The same read keeps `Pause.watch` current,
   which the page follows for its Paused badge and its Pause and Resume button.
6. The gateway reads `LiveTurns`, which says who the turn runs for, on every call that names its turn, which the `acp` runtime does in its
   headers and the `api` runtime around each turn. A call in a turn that was stopped, or ended, or never
   ran on this server is refused before the grant, as `deny` with `reason: "turn ended"`, and the model
   reads that nothing more runs in it. A call still running when its turn is stopped is cut off, and its
   `allow` row settles `unknown` with `the turn was stopped`. A command still waiting for the one before
   it is cut off with a `deny` row, `turn ended`, and the door checks the turn again when it lets one in,
   so a command whose turn ended while it waited never runs. So a CLI that ignores `session/cancel` acts
   no more, and a call it made over `/mcp` ends with the turn.

Pausing every Bot at once waits for admin controls.

## Files in and out of the workspace

A person gives the Bot a file to work on and downloads the file it made, without copying text through the
chat. Both are the person's own calls, not the Bot's, so they do not go through the Bots' door: a person
holding the computer can still move files. `FileTransfers` does them, from the same layer as `Gateway`.

1. `＋` in the composer uploads a picked file at once with `PUT /files?path=<name>`. The server
   needs its `Content-Length`: past 100 MiB it is `file.uploaded · deny` with `{ reason: "too large" }`
   and a 413 before a byte of the body is read. Otherwise `file.uploaded · allow` with
   `{ path, name, extension, bytes }`, the computer is started if none runs, and the body streams through
   to the computer's own `PUT /files?path=`, never held whole. The computer writes it to a file of its own
   in the same folder and renames it into place only once all of it arrived, counting as it goes: past 100
   MiB it stops with 413 and keeps nothing. The outcome row says `succeeded` with the bytes saved, or
   `failed` with `{ reason: "the upload stopped partway" }` when the person's body broke off, since the
   computer kept none of it. Taking the chip out while it uploads stops the upload.
2. The message the person sends then ends with a line naming every file that arrived, such as
   `I put expenses.csv in your workspace.`, so the model knows it is there. Those chips clear only once
   the message went, so a message the conversation turned away keeps them.
3. A `write_file` card that is done holds a file chip, a link to `GET /files?path=`. That is
   `file.downloaded · allow` with `{ path, name, extension }`, and the computer's `GET /files?path=` streams
   the exact bytes back with their length, through the server to the browser. A download never starts a
   computer. Its outcome row is written when the person's request ends: `succeeded` with the size when
   the last byte went out, and `unknown` when the person went away before it or the body was never sent.
   The computer's answer is dropped then too, read to its end or not. A `HEAD /files` is answered 405
   without asking the computer, and writes no row.

A path that is absolute or goes up with `..` is a `deny` row with `{ reason: "outside workspace" }`, and
the computer never hears of it. The rows never hold what a file holds. Both spans, `FileTransfers.upload`
and `FileTransfers.download`, record `gateway.file_bytes`; the download's lasts until the person's request
ends. The HTTP client's spans of the server's requests to the computer's `/files` record the path as
`REDACTED`.

## Secrets

Nothing a Bot typed, and no secret a person gave it, is kept in the chat, the audit trail or telemetry.
Three things hold that up.

**A person types a secret, never the chat.** A Bot that needs a password calls
`request_secret({ ref, field })`, naming the field for its person, such as `the password for the login
page`. The gateway checks the grant, holds a request for the Bot, then checks the door, the ref and the
rules as for `type`, with `tool.name == "request_secret"` and the element the ref names. Each Bot has at
most one request at a time; a second is `secret.requested · deny` with `{ reason: "already asked" }`
before anything is judged. The ref must name a `textbox` or a `searchbox`, else the call is
`secret.requested · deny` with `reason: "not a text field"`, and the computer itself refuses `type_secret`
for any element but a text `<input>` or a `<textarea>`: what a contenteditable element holds is page text,
which no read hides. A page on no site, such as `about:blank` or a `data:` page, has no host to show the
person, so a request there is `secret.requested · deny` with `reason: "no site"`. Once `secret.requested · allow` is written, the request gets an id from the server and
is shown to the person: `Secret.pending { bot }` streams it as `{ request, field, host }`, with the host of
the field's page as the server read it, so the card says "the password on shop.example" and a Bot cannot
pass one site's field off as another's. It then waits for the person outside the door, so a person can
take the computer meanwhile. The page draws the request as a secret card (see `docs/design.md`). Supply
sends the value over `Secret.answer { bot, request, answer }` on its own socket, as a `Redacted` that a
log, an error or a span prints as `<redacted>`, and the page wipes it once the call settles; it never goes
into the conversation. An answer for any other request than the one shown, or one that comes after the
wait ended, fails with `NoSecretRequested`: the request is withdrawn the moment its wait ends, before any
row is written. The request's row then says `succeeded`, and the gateway writes `secret.supplied · allow`
with the value's length as `chars`, then forwards `type_secret` through the door. The computer marks the
field and fills it, and the model reads that its person typed it, with the page read afresh. Decline, ten
minutes without an answer, and a stopped turn settle the request as `failed` with `declined`, `no answer`
or `the turn was stopped`, and nothing is typed. A person who holds the computer by the time they answer
keeps it: `secret.supplied · deny` with `a person has control`.

Both runtimes' stall limit counts only time no tool call runs, so the wait does not end the turn: `api`
counts the tool handlers that run, and `acp` the tool calls the CLI reported through `session/update` that
have not ended. `acp` has that only from the CLI, so a call it never reports ended holds the turn at most
`longestToolCall`, the ten minutes a request waits plus the longest forwarded action, and the stall limit
after it, and the turn then fails as stalled. An MCP call that its client cancels with
`notifications/cancelled`, or whose connection closes, as when the turn ends and its CLI is stopped, ends
the wait at once: the request is withdrawn and its row settles `failed` with `the turn was stopped`. An
`acp` CLI also has its own limit on an MCP call. Claude Code ends one after five minutes without an
answer, so it is started with `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` a minute past the ten minutes a request
waits. Codex reads a tool timeout only from a server in its own `config.toml`, not from the one its
session is handed, and its default is two minutes. When that passes, Codex stops waiting for the call and
reports it failed, but, as its source reads, sends no `notifications/cancelled` and keeps the
connection open, so the gateway still waits. The Bot reads that the tool failed, and its card says it did
not get the secret, since the call no longer runs, so nothing can be supplied any more. The request waits
on until the turn ends, or for the rest of its ten minutes, `no answer`, and until then the Bot's next
`request_secret` is `already asked`.

**The computer never reads a secret back.** Playwright's snapshot prints what a field holds, a password
field's included (`textbox "Password" [ref=e3]: hunter2`). After every action the computer asks the page
which filled fields are `input[type=password]`, a one-time code, a current or new password by their
`autocomplete`, or marked by `type_secret`, and shows their value as `"[hidden]"`; a field the page does
not answer for is hidden too. A page can also show a secret elsewhere: a form sent by GET writes a
one-time code into the address (`?code=123456`), and a page can echo what was typed. So the computer keeps
every value it typed with `type_secret`, in memory only and for as long as it runs, and shows each place
one appears in a read's address, title and snapshot as `[hidden]`, as typed, as an address or a form
encodes it, and quoted in a snapshot. The address's origin stays as it is, since the server judges the
page by its host. A value shorter than four characters is not looked for, since text that short, such as
a year, is too likely to be the page's own. A marked field is drawn with dots on the live screen. The server keeps the
latest snapshot with no field's value at all, since a ref resolves by its role and name, and of the
page's address only its origin, since a form sent by GET writes its fields into the query.

**What is recorded is redacted, by one module.** `redact()` keeps a typed text's length, as
`[14 chars]`. `redactUrl` keeps an address's path and the names of its query and fragment, never their
values or its userinfo: `?token=abc`, `?q=x` and `#access_token=…` lose their values whatever they are
called, and so does userinfo a browser reads in an address not written `scheme://`, such as
`https:/ada:pw@h.example`. `navigate` rows keep the address that way, and the computer is still sent it
as written. The model and the transcript read a page's address through `redactUrlSecrets`, which keeps
a query value unless its name holds a credential word, so `?page=2` stays usable and `?password=` does
not. `redactCommand` keeps a command as written but for the value of an assignment, flag or JSON field
whose name ends in a credential word (`API_TOKEN=abc`, `DB_PASS=x`, `--password=x`, `--token x`,
`"password":"x"`), a credential header (`-H "Authorization: Bearer x"`, `--header=Cookie:x`), the
password after curl's or wget's `-u user:pass`, `--user` or `--proxy-user` and after `-p` where `mysql`,
`docker login` or `sshpass` read it, a bearer token in any case, and every address in it, redacted as
above; `run` rows keep that, redacted first and then capped, so a secret the cap would cut is redacted
whole. A name that ends in no credential word keeps its value, so `--output report.pdf`, `--body done`
and `TEXT=hi` stay, and so does `docker run -u 1000:1000`. A `--no-` flag is a switch, and a value ends
at a quote, a redirect or an operator, so `--no-auth y`, `< token.txt` and the quote closing
`-m 'fix: token=abc'` stay as written. Matching a command's text is a filter: a secret
written some other way, such as `echo hunter2 | login`, stays in the row. Every span attribute, whoever
writes it, keeps only the length of a value under a key that may hold a secret or a tool's input or
output, in any spelling (`toolResult`, `tool_result`, `x-api-key`, `accessToken`), and every address in
any other value loses its query values, fragment and userinfo.

## Asking the person

An ask rule makes an allowed action wait for the person's yes. The question is a card in the chat (see
`docs/design.md`), never a modal, and the answer is part of the audit trail.

**The turn names its conversation.** A tool call knows the conversation and the run it is made in: the
`api` runtime puts them in the `ActingBot` claim, and the `acp` runtime sends them with the Bot on every MCP
call, as the `aobot-conversation` and `aobot-run` headers next to `aobot-bot`. Every message the person
writes starts a new run. A call that names no turn, such as one whose headers do not decode, has no person
to ask, so an action an ask rule holds for is refused with `no one to ask`.

**The gateway asks before anything runs.** An `Allowed` verdict names the allow rule, and the ask rule
as `ask` when one holds. The action leaves the door before any row is written, and the gateway, in
`gateway/approvals.ts`:

1. Holds a question for the conversation. One waits per conversation at a time, so a second action is
   refused with `already waiting` and gets no second card.
2. Reads the ledger. A no to the same ask rule earlier in this run refuses it with `declined earlier`,
   without a card. A yes an earlier run spent and never finished, as when the person stopped the turn or
   the server stopped while the action ran, refuses it once with `outcome unknown`; the action is never
   run again, and the next one gets a card.
3. Writes `<tool> · ask` with the action's audit detail, `rule` (the ask rule), `allowedBy` and the
   `approval` id, and the ledger row `asked`, in one transaction, then shows the card. `Approval.pending { conversation }`
   streams it as `{ approval, tool, question }`. The server words the question from the action as it
   resolved, and shows what the person approves as the Bot wrote it: the whole command, the address and
   the text it would type (``Run `rm notes.txt`?``, `Click the button "Delete" on shop.example?`). The
   question reaches only the person's own page, never an audit row, a log, a span or the conversation, so
   it is neither redacted nor cut: `redactCommand` turns `API_TOKEN="$(find . -name notes.txt -delete)"`
   into `API_TOKEN="[33 chars]"`, which would hide the very part an ask rule asks about. The audit rows
   keep their redaction.
4. Waits outside the door, at most ten minutes, in a `Gateway.awaitApproval` span with `gateway.rule`,
   `approval.answer` and `approval.by`. `Approval.answer { conversation, approval, answer }` answers it;
   an answer for another question, or one after the wait ended, fails with `NoApprovalWaiting`. Whoever
   takes the card down first answers: the person, or the time limit, which answers no. A stopped turn
   answers no too. `approval.answered · answered` records `{ bot, approval, answer, by }`, in one
   transaction with the ledger's `yes` or `no`, with `by` one of `ApprovalAnsweredBy` in the domain
   package: `person`, `time limit`, `the turn was stopped` or `the server stopped`.
5. On no, writes `<tool> · deny` with `reason: "declined"` or `"no answer"`, and the model reads that its
   person said no and not to try it another way until they write.
6. On yes, resolves the request again through the door. The approval is bound to a digest of the action
   as it resolved, the element a ref names and a file's contents included, so a ref that names another
   element by now is refused with `action changed`. It then spends the approval and writes `<tool> ·
   allow` naming the allow rule as `rule`, the ask rule as `asked` and the approval, in one transaction
   a stopped turn cannot split, and forwards it once. An asked `run` waits for the command queue before it
   is judged, so its card shows only once the commands asked for before it ran.

**Every asked action closes in the trail.** From its `ask` row on, an asked action ends in one row that
names its `approval`: its `allow` row, which an outcome row settles, or a `deny` row. A refusal after a
yes (`action changed`, `a person has control`, a ref that no longer resolves) keeps the action as it
resolves now. A turn stopped before the action ran, while the card was up or while the approved command
waited its turn, writes a `deny` row with `reason: "the turn was stopped"`. Each `deny` row after the
`ask` row is written in one transaction with lapsing the question when it is still `asked` or a `yes`
not spent. A row that cannot be written once the person was asked, its answer or its `allow` row, is
refused as `not recorded` the same way. A server that stopped while a question was open closes it at
the next start-up, beside the sweep of `allow` rows without an outcome: an `asked` question gets
`approval.answered` with `by: "the server stopped"`, and the question, or a yes never spent, a `deny` row
with the same reason, both written by the deployment on the authority of the person it asked, in one
transaction with the ledger's move. A second start finds nothing left to close.

**The ledger never runs ahead of the trail.** The ledger and the audit trail share one SQLite client, so
every move of a ledger row commits in one `sql.withTransaction` with the audit rows that record it, or
neither does: `approvalRequests` takes each move's rows as an argument, so no move can be written
without them. A failed write leaves the row where it was. A question whose closing rows failed stays
`asked` or `yes`, and the next start-up's sweep closes it with its own rows; one whose rows fail there
too stays for the start after.

The ledger is the `approvals` table, one row per question:
`(id, conversation_id, run_id, bot_id, tool, rule, state, actor_id)`, no action, digest or typed text;
the Bot, the tool and whose authority it was asked on are kept only so a question a stopped server left
open can be closed in the trail, a question asked before `actor_id` existed naming the deployment. A row only
moves forward, each move one compare-and-set `UPDATE`: `asked → yes | no | lapsed`, `yes → spent |
lapsed`, `spent → finished | told`. A trigger refuses any other change, and any delete. A yes is spent by
moving it to `spent`, so a second spend finds nothing to move and is refused with `already spent`. A
yes not spent when its question is refused, as after `action changed` or a stopped turn, moves to
`lapsed` with the `deny` row, and so does a question still `asked` whose answer could not be recorded. The row
moves to `finished` once the Bot was told what became of the action. A row left `spent` belongs to a run
that stopped before that, and the next run's equivalent action moves it to `told` and is refused, once.

"Equivalent" means the same ask rule. A no to `rm notes.txt` under `ask-before-rm` also covers
`rm ./notes.txt`, for the rest of the run. That is coarse on purpose: a Bot cannot ask again under a new
spelling, and the person writing again starts a new run.

`request_secret` under an ask rule is not asked twice: the secret card already asks the person, so its
`allow` row only names the ask rule as `asked`. The card is that rule's question in both directions. It
holds the conversation's one question while it waits, so it is refused with `already waiting` while an
approval card waits there, and an action under the same rule gets no approval card beside it, only
`already waiting`. A no to that rule earlier in this run refuses it with `declined earlier`, so a Bot told
no to typing into a field cannot put a secret card up for it. And declining the secret card, or not
answering it within ten minutes, is a no to that rule: a ledger row `no` for the conversation, run and
rule, written in one transaction with the request's `failed` outcome row, so a second secret card or an
action under the rule is refused with `declined earlier` for the rest of the run.

The wait is as long as a secret's, so `longestToolCall` covers both and the stall limit does not end the
turn. The known gap is the same as for secrets: Codex stops waiting on an MCP call after two minutes
without cancelling it, so a yes given later runs an action the Bot already read as failed.

## Gateway tools

Every tool a Bot can be granted, in either runtime. The tool map test (`apps/server/src/features/gateway/tool-map.test.ts`)
fails when a tool in `botToolkit` is missing here or a row here names no tool. Each call writes the `allow`
row first, then one outcome row linked to it by `outcome_of`. Both carry the turn's `trace_id`; the outcome row
copies the action, and its `detail` says why for `failed` and `unknown`. An `allow` row's `detail` ends with
`rule`, the allow rule that allowed it, and a rule's refusal is a `deny` row as
[Rules that fail closed](#rules-that-fail-closed) says. Every row's `detail`, `deny` rows
included, starts with `bot`: the id of the Bot the call was made for, or `null` when it named none by its
id. The `Gateway.act` span records it as `gateway.bot`. A ref's row keeps the `host` of its page, which
is what a rule judged, never the page's address: a query or fragment can carry a token, such as an OAuth
`#access_token=…`. The server keeps no more of that address than its origin, which the computer is sent
as `url` to check the page is still on that site; for an opaque origin, such as `about:blank`'s, it keeps
the whole address.

| Tool             | Parameters         | Computer action                                                                                      | Audit rows                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------- | ------------------ | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `navigate`       | `url`              | `POST /act {"action":"navigate","url"}`                                                              | `navigate · allow` with `{ bot, url }`, its query values and fragment redacted, then `succeeded`, `failed` or `unknown`                                                                                                                                                                                                                                                                                                                                        |
| `snapshot`       | none               | `POST /act {"action":"snapshot"}`                                                                    | `snapshot · allow` with `{ bot }`, then `succeeded`, `failed` or `unknown`                                                                                                                                                                                                                                                                                                                                                                                     |
| `click`          | `ref`              | `POST /act {"action":"click","target":{ref,role,name,url}}`                                          | `click · allow` with `{ bot, ref, role, name, host }`, then `succeeded`, `failed` or `unknown`; `click · deny` with `{ bot, ref, reason }`                                                                                                                                                                                                                                                                                                                     |
| `type`           | `ref`, `text`      | `POST /act {"action":"type","target":{ref,role,name,url},"text"}`                                    | `type · allow` with `{ bot, ref, role, name, host, text: "[N chars]" }`, then `succeeded`, `failed` or `unknown`; `type · deny` with `{ bot, ref, reason }`                                                                                                                                                                                                                                                                                                    |
| `press`          | `ref`, `key`       | `POST /act {"action":"press","target":{ref,role,name,url},"key"}`                                    | `press · allow` with `{ bot, ref, role, name, host, key }`, then `succeeded`, `failed` or `unknown`; `press · deny` with `{ bot, ref, reason }`                                                                                                                                                                                                                                                                                                                |
| `run`            | `command`          | `POST /act {"action":"run","command"}`                                                               | `run · allow` with `{ bot, command }` (capped at 2,000 characters, secrets redacted), then `succeeded`, `failed` or `unknown`                                                                                                                                                                                                                                                                                                                                  |
| `read_file`      | `path`             | `POST /act {"action":"read_file","path"}`                                                            | `read_file · allow` with `{ bot, path, name, extension }`, then `succeeded`, `failed` or `unknown`; `read_file · deny` with `{ bot, path, name, extension, reason }`                                                                                                                                                                                                                                                                                           |
| `write_file`     | `path`, `contents` | `POST /act {"action":"write_file","path","contents"}`                                                | `write_file · allow` with `{ bot, path, name, extension, bytes }`, then `succeeded`, `failed` or `unknown`; `write_file · deny` with `{ bot, path, name, extension, reason }`                                                                                                                                                                                                                                                                                  |
| `list_files`     | `path`             | `POST /act {"action":"list_files","path"}`                                                           | `list_files · allow` with `{ bot, path, name, extension }`, then `succeeded`, `failed` or `unknown`; `list_files · deny` with `{ bot, path, name, extension, reason }`                                                                                                                                                                                                                                                                                         |
| `request_secret` | `ref`, `field`     | once the person answered, `POST /act {"action":"type_secret","target":{ref,role,name,url},"secret"}` | `secret.requested · allow` with `{ bot, ref, role, name, host, field }`, then `succeeded` or `failed`; `secret.supplied · allow` with `{ bot, ref, role, name, host, field, chars }`, then `succeeded`, `failed` or `unknown`; `secret.supplied · deny` with `{ bot, reason: "a person has control" }`; `secret.requested · deny` with `{ bot, ref, reason }`, or with `{ bot, ref, role, name, host, field, reason }` for `"not a text field"` or `"no site"` |

Any tool can also be refused by a rule, as `<tool> · deny` with its audit detail and the rule (see
[Rules that fail closed](#rules-that-fail-closed)).

While a person holds the computer, every granted tool of every Bot is refused before its ref is resolved: `<tool> · deny`
with `{ bot, reason: "a person has control" }` (see [Taking control](#taking-control)).

Every browser action answers with the page read afresh: its URL, title and snapshot, capped at 12,000
characters. The URL keeps its path and every query value but one under a credential name, such as
`?password=`, and loses its fragment's values and its userinfo, since a form sent by GET or an OAuth
redirect writes a secret there. `type` replaces what the field holds and never presses Enter. `press` presses one key on an element:
`Enter`, `Tab`, `Escape`, `Backspace`, `Space` or an arrow key, and like `click` reads the page once what it led
to has loaded, so Enter in a field reads the page its form submitted to.

`run` answers how the command ended and the last 8,000 characters of each of stdout and stderr, each with
a note when its start was dropped. It ended `Exited` with bash's exit code, `Signalled` when a signal the
computer did not send ended bash (`kill -TERM $$`, a crash, the out-of-memory killer), or `TimedOut` when
it was still running after 30 seconds. A command that exits non-zero still `succeeded`: the computer ran
it, and the model reads how it ended. Once bash ends, the computer kills the command's process group, so
a background job such as `sleep 600 &` neither holds the answer until the time limit nor outlives it.
After a non-zero exit that happens at once. After exit 0 or a signal, the output first gets half a second
more, and when something still holds it open then, the model reads that the computer stopped what the
command left running. The time limit counts only until bash ends. A timeout and a Stop kill the group the
same way. A Bot's commands wait for each other in the gateway, so each one's time limit starts when the
one before is done.
The `Gateway.act` span records `gateway.command_end` (`exited`, `signalled` or `timed_out`) with
`gateway.exit_code` or `gateway.signal`; the command is in the audit row, never in a span or a log.

`read_file`, `write_file` and `list_files` name a file by its path inside `/workspace`, such as
`reports/august.csv`; the audit row records that path with its `name` and `extension`, the three that
rules see as `file.path`, `file.name` and `file.extension`. The extension is what follows the name's last
dot, lower-cased, for a name that starts with one too: `.env` and `prod.ENV` are both `env`. The path is
a `WorkspacePath` from the domain, on the tools, on `/act` and on both `/files` routes: `""` is read as
`.`, the workspace itself, and nothing is trimmed, so the gateway and the computer judge the very same
name, and `a.txt ` is a file of its own. A path is judged as the computer, which runs Linux, reads it:
only a leading `/` makes it absolute and only `/` separates, so `c:notes.txt` and `a\b.txt` are each one
file's name. A path that is absolute, `/workspace/notes.txt` included, or that goes up with `..` is
denied before anything is forwarded, the computer never hears of it, and the model reads:

> read_file did not run: /etc/passwd is outside your workspace. Name a file by its path inside /workspace,
> such as notes.txt, with no leading / and no "..".

The computer confines every path again on its own, because only it can see where a link leads: resolved on
disk, with every link followed as the kernel follows it, the file must still be inside `/workspace`,
compared as a relative path so `/workspace-evil` is not inside it. Node's own `realpath`, which `FileSystem`
uses, reads `..` after a link as text and would put `sub/..` back inside when `sub` leads out, so the
workspace asks the kernel instead. A write also follows a link already at its name, dangling or not, each
hop read from the folder it really is in. A link that points back inside keeps working. A link that leads
out is refused there, an `allow` row followed by `failed`.

`read_file` answers the first 16,000 bytes as UTF-8 text with the file's size, wrapped as untrusted
`file contents`. `write_file` saves at most 1 MB, writing a file of its own beside the target, under a short
name of its own so the longest name still fits, and renaming it into place, so a failed write leaves what
was there. `list_files` answers at most 500 files and folders, every level down, in name order, and does
not follow links. A folder it cannot open, or a file it cannot size, is listed as could not be read, and
the rest of the listing still comes back. The `Gateway.act` span records
`gateway.file_bytes` for a read or a write and `gateway.file_entries` for a listing; never a path or what a
file holds.

### Refs

A ref such as `e12` names one element of the latest snapshot of the page. Every Bot drives the one
browser on the computer they share, so the gateway stores one snapshot for that computer in the database
(`computer_snapshot`), with the Bot whose browser action read it (`read_by`), replacing both after every
browser action that answered, whichever Bot asked. Any replica resolves a ref the same way. Before any
rule runs, `click`, `type` and `press` resolve their ref to the element's role and name, and the
address the snapshot was read at. A ref resolves only for
the Bot that read the latest snapshot: another Bot's refs name a page it saw before the page changed, and
the same ref can name a different element on the new page, which the computer's own check would not
catch. Such a ref is a `deny` row with `another Bot read the page since`, the computer never hears of it,
and the model reads:

> click did not run: the page changed since you last read it. Take a snapshot and use a ref from it.

A ref that is not in the snapshot its Bot read is a `deny` row too, and the model reads:

> click did not run: e12 is not a ref in the page's latest snapshot. Take a snapshot and use a ref from it.

The gateway sends the computer the resolved element and that address, not just the ref. The rules judged
the action by that page's host, so when the page is on another origin by now (a parallel call navigated,
or the page moved by itself) the computer refuses it, even when the new page shows the same element:

> The page is on another site than your latest snapshot read, so e12 is not the button you saw. Take a
> snapshot again and use a ref from it.

The origin is compared, not the whole address, so a single-page app that changes its query or hash keeps
its refs. Then the computer reads the page afresh. When the element at that ref is gone or no longer has
that role and name (the page changed, or a navigation started Playwright's ref counter again), it refuses
with:

> The page changed since your latest snapshot, so e12 is not the button it was. Take a snapshot again and
> use a ref from it.

A tool result reaches the model through one seam: `markUntrusted()`, a 20,000-character cap with a visible
`[truncated: N characters]` note, and a per-tool timeout. A failed call is a result the model reads, not a
dead turn.

## Decisions

| #   | Decision                                                                                              | Why                                                                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **No CopilotKit Intelligence.** Threads, messages and audit live in our own database (SQLite for now) | No external licence, no data outside our account                                                                                                                                                                                                                        |
| 2   | **The think-act loop is a provider**: `api` (effect/ai) or `acp` (your own CLI)                       | Any model in the cloud, your own subscription on a laptop, and in both the gateway is the only way to act. Not the Claude Agent SDK: its built-in tools run inside the server, beside the database file                                                                 |
| 3   | **Effect v4** on the server                                                                           | Typed errors make every gateway path visible, layers make providers swappable, `Effect.fn` gives tracing for free                                                                                                                                                       |
| 4   | **Web first, Electron as a wrapper**                                                                  | The agents run in the cloud, so the desktop app adds safe token storage and notifications, not core logic                                                                                                                                                               |
| 5   | **The page as text, not screenshots**                                                                 | `ariaSnapshot({ mode: "ai" })` with refs is cheap and needs no vision model. Snapshots are capped at 12,000 characters                                                                                                                                                  |
| 6   | **A computer is only ever "a URL and a token"**, or for a Mac, a connection the desktop app opened    | The server never uses `docker exec` or shared files, so where a computer runs can change freely. A laptop is behind NAT, so it dials out                                                                                                                                |
| 7   | **Fail closed**                                                                                       | A missing rule permits nothing, a crashing rule denies, a missing grant is refused before any rule runs                                                                                                                                                                 |
| 8   | **Never log what a Bot typed**                                                                        | The audit row keeps `"[14 chars]"`, not the value. It may be a password. A `run` command is the exception: its audit row keeps it as written, capped at 2,000 characters, because the command is what the row is for, with the secrets `redactCommand` finds redacted   |
| 9   | **OpenTelemetry from day one**                                                                        | One trace per chat turn, with the `trace_id` stored on every audit row                                                                                                                                                                                                  |
| 10  | **Outside content is untrusted data**                                                                 | Pages, command output and files reach the model inside one envelope that says they carry no authority. A page can say "ignore your instructions"; the envelope is what tells the model that is not its person speaking. A closing tag inside the content is neutralised |
| 11  | **Every audit row names its initiator**                                                               | `initiator_kind` is `person` or `deployment` now, `routine` and `handoff` later. `actor.id` says on whose authority; only this says whether anybody was watching                                                                                                        |
| 12  | **AG-UI events over Effect RPC, read through atoms**                                                  | One `ChatEvent` Schema in `packages/domain` with AG-UI's event names and fields, streamed by an Effect RPC and decoded on both sides. The web reads it through `effect/reactivity` atoms in a few hooks, shaped like CopilotKit's. No CopilotKit dependency             |

## The web app

React with `@effect/atom-react`. State lives in atoms from `effect/reactivity`; components read them
through a few hooks. The hooks copy the _shape_ of CopilotKit's
(`~/Projects/opensource/CopilotKit/packages/react-core/src/v2/hooks/`), not their mechanics: no Bot
tool ever runs in the page, so nothing depends on a tab being open.

```ts
// packages/domain: one schema, encoded by the server and decoded by the web
export class ChatRpcs extends RpcGroup.make(
  Rpc.make("Chat.send", { payload: SendMessage, success: ChatEvent, stream: true }),
  Rpc.make("Chat.stop", { payload: ConversationRef }),
) {}

// apps/web: the RPC client as an atom service, one conversation atom per id
class ChatClient extends AtomRpc.Service<ChatClient>()("ChatClient", { group: ChatRpcs, protocol }) {}
const conversation = Atom.family((id: ConversationId) => /* fold ChatEvents into one ordered transcript and a status */)
```

| Hook                          | Shaped like CopilotKit's             | What it gives a component                                                                                                                                                                    | From |
| ----------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `useConversation(id, bot)`    | `useAgent`                           | The conversation's own `bot`, `transcript` (messages and tool calls in order), `isRunning`, `usesComputer`, `unsent`, `send`, `stop`                                                         | E0-1 |
| `useToolCallRenderer()`       | `useRenderTool`, `useRenderToolCall` | A registry from tool name to a component that draws one tool call in each of its states                                                                                                      | E1-1 |
| `useLiveScreen()`             | (none)                               | The latest screen frame, none while the screen is blank                                                                                                                                      | E1-4 |
| `useControl()`                | (none)                               | Who holds the computer every Bot shares, why the last take, click or hand back failed, `takeControl`, `handBack`, `click`                                                                    | E1-5 |
| `useAttachments(id, send)`    | (none)                               | The files picked in the conversation's composer and how each upload went, `attach`, `dismiss`, and `send`, which names the files that arrived                                                | E1-6 |
| `useBots()`                   | (none)                               | The Bots the server knows, as `bots.yaml` lists them, for the sidebar                                                                                                                        | E2-1 |
| `useSelection()`              | (none)                               | The Bot and conversation the page has open, as the server confirmed it, and `pick` to open another Bot                                                                                       | E2-1 |
| `useSecretRequest(call, bot)` | `useHumanInTheLoop`                  | What a `request_secret` card shows, with the request `Secret.pending` streams for the Bot, `supply`, which sends the typed secret over `Secret.answer` with that request's id, and `decline` | E2-3 |
| `useApproval(id, turn)`       | `useHumanInTheLoop`, `useInterrupt`  | The approval card of the conversation: the question `Approval.pending` streams, the answer for the rest of its turn, and `choose`, which sends yes or no over `Approval.answer`              | E2-5 |
| `usePause(bot)`               | (none)                               | Whether the Bot is paused, once the server said, whether a pause or a resume is on its way, why the last one failed, `pause` and `resume`                                                    | E2-7 |
| `usePausedBots()`             | (none)                               | The Bots paused now, none until the server has said, for the sidebar's Paused labels                                                                                                         | E2-7 |
| `useSession()`                | (none)                               | Who the page is open for, none until the server has said, read again every half minute and on focus                                                                                          | E3-1 |
| `useAuditTrail()`             | (none)                               | The audit rows the URL's filters let through, newest first, whether older ones are left, why the last page failed, `filter`, `loadMore` and `reload`, which reads the trail again            | E2-4 |

The page opens the Bot and the conversation the URL names as `?bot=<id>&c=<id>`, or the first Bot in
`bots.yaml`; a `bot` that is no Bot the server knows, or no Bot id at all, opens the first Bot and drops
the URL's conversation. One writable `selection` atom holds it: its read side derives it from the URL, the
Bot list, a memory of each Bot's last conversation and what `Chat.open` answered for that pair, and
corrects the URL to show it without a history entry; its write side takes a picked Bot and pushes a
history entry, so Back returns to the Bot before. The memory lives in an atom and is mirrored to
`localStorage` at best, so a private window still returns to the conversation a person left. Each write
takes in what other tabs stored first, so two tabs never overwrite each other's Bots. Each sidebar entry
is a link to `?bot=<id>`, so it opens in a new tab or copies like any link.

A conversation belongs to the Bot of its first message. `Chat.open` and `Chat.send` name the Bot the page
picked; the server refuses another Bot with `ConversationOfAnotherBot`, naming the conversation's own,
and a Bot the file does not name with `UnknownBot`. The page follows the first to the conversation's Bot;
a message `Chat.send` was refused for goes back into the composer, where it stays through the follow.
The second means the page's Bot list is out of date: the page asks for it again, once per answer, and
stays on the Bot with its refusal until the fresh list resolves the URL to a Bot it names. It never moves
to a Bot only the old list named, so two Bots the server forgot cannot send it back and forth. It
remembers a Bot's conversation only once the server opened it with that Bot.

Not copied: `useFrontendTool` (it runs a Bot's tool in the open tab, which breaks routines, the Mac and
closed tabs) and CopilotKit's provider. The wire format stays AG-UI, so a CopilotKit or other AG-UI client
could still connect through a thin adapter later.

## Local now, AWS later

Two switches decide where things run. Code never checks which one is active.

| Switch                           | Local (now)                                                       | AWS (later)                                                      |
| -------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| `AGENT_RUNTIME`                  | `acp` on your own subscription, or `api` with a key               | `api` only                                                       |
| `COMPUTER_PROVIDER`              | `docker`: one container per person, a named volume for its logins | `ecs` (RunTask in a private subnet), later `k8s` (agent-sandbox) |
| `OTEL_EXPORTER_OTLP_ENDPOINT`    | the `grafana/otel-lgtm` container                                 | the AWS OpenTelemetry collector (ADOT) or Grafana Cloud          |
| `DATABASE_PATH` / `DATABASE_URL` | a SQLite file on a Compose volume (`DATABASE_PATH`)               | RDS Postgres with pgvector (`DATABASE_URL`)                      |
| Secrets                          | `.env` through Effect `Config`                                    | AWS Secrets Manager                                              |
| Model                            | Whatever your CLI uses, or any `effect/ai` provider with a key    | Any `effect/ai` provider; Bedrock is decided in E5-1             |

Rules that keep the move cheap:

1. SQLite locally, Postgres on AWS. aobot is a learning project and a proof of concept with one server process, so one file beats a database container. Moving to the cloud means switching to Postgres then (E5-1), and the in-memory one-run-per-conversation guard becomes a shared lock the day there is a second replica. Keep SQL inside the feature stores so that switch stays in one place.
2. Settings and secrets only through Effect `Config`, never `process.env` in application code.
3. Computers never publish ports. Only the server's network can reach them.
4. The images Compose runs are the images AWS runs.
5. Every computer provider passes the same contract test suite before it is used. See [testing.md](testing.md).

The `Computers` service has OpenBot's four supervisor operations, plus `screen`. There is one shared
computer until E3-3 adds a `person` argument:

```ts
export interface Interface {
  readonly ensure: Effect.Effect<Computer, ComputerUnavailable>; // start if needed, wait until healthy
  readonly running: Effect.Effect<Computer, ComputerUnavailable>; // the one running, never starting one
  readonly stop: Effect.Effect<void, ComputerUnavailable>;
  readonly reset: Effect.Effect<void, ComputerUnavailable>;
  readonly list: Effect.Effect<ReadonlyArray<ComputerStatus>, ComputerUnavailable>;
  // The running computer's screen for any number of viewers. Never starts a computer, never fails.
  readonly screen: Stream.Stream<Screen>;
}

// A running computer: a URL and a token, whichever provider started it. `browse`, `run` and `files` are
// `POST /act`, and each reads only the answer its action promises, so a page answering a command is
// ComputerLost. `download` and `upload` are `GET` and `PUT /files`, a file's bytes as they are. `input` is
// `POST /input`, what a person in control did on the screen.
export interface Computer {
  readonly browse: (
    action: PageAction,
  ) => Effect.Effect<PageRead, ComputerActFailed | ComputerLost>;
  readonly run: (
    command: RunCommand,
  ) => Effect.Effect<CommandRan, ComputerActFailed | ComputerLost>;
  readonly files: (
    action: FileAction,
  ) => Effect.Effect<FileAnswer, ComputerActFailed | ComputerLost>;
  readonly download: (
    path: string,
  ) => Effect.Effect<FileDownload, ComputerActFailed | ComputerLost>;
  // A body that fails partway fails the upload with its own error.
  readonly upload: <E>(
    path: string,
    body: Stream.Stream<Uint8Array, E>,
  ) => Effect.Effect<FileSaved, ComputerActFailed | ComputerLost | E>;
  readonly input: (input: PersonInput) => Effect.Effect<void, ComputerActFailed | ComputerLost>;
}
```

## Security notes

A Bot has a shell and a browser. The browser reaches only what the egress filter allows. A command
reaches the same as long as it uses the proxy settings it is given, and whatever the computer's network
reaches when it does not, until network limits (E5-3). These hold locally as much as on AWS:

- **The database is not on the computers.** The SQLite file lives on a volume only the server mounts, so a
  Bot's shell has no file to read or write.
- **The browser refuses private and metadata addresses.** `169.254.0.0/16`, `fe80::/10`, loopback and
  private ranges are refused, so a Bot cannot browse to internal services. `COMPUTER_ALLOW_PRIVATE_HOSTS`
  exists for local fixtures and stops the server from starting in production.
- **Single-user mode never faces the internet.** With it on, every request is one administrator. The
  server refuses to start if its public URL resolves to a public address, and warns on a private one.
- **Every request needs a session.** The gate covers every route, and every RPC group carries `SignedIn`,
  checked by a test. Sessions are random tokens kept only as SHA-256 hashes, in HttpOnly SameSite=Lax
  cookies, read again on every request, so a removal or sign-out holds at once. The callback redirects
  only to a path on this server, and reads its address from `PUBLIC_URL`, never `Host`.
- **A command does not inherit the computer's environment.** It gets PATH, the locale, `HOME=/workspace`
  and proxy variables naming the computer's egress filter, from an allow-list, so `env` never prints
  `COMPUTER_TOKEN` or a secret added later. A command that honours those variables is held to the
  browser's destinations, and private hosts stay refused to it even where `COMPUTER_ALLOW_PRIVATE_HOSTS`
  opens them to the browser. A command can still unset them and connect directly; network limits close
  that (E5-3). `bash -c`, never a login shell, so a `.bash_profile` the Bot wrote cannot run first.
- **A Bot's files stay in `/workspace`.** The gateway denies a path that is absolute or goes up with `..`,
  and the computer refuses one that leads out once links are followed. A command can still read anything
  its user can, which is the shell's reach, not the file tools'.
- **`/act`, `/files`, `/input` and `/stream` refuse callers on the computer itself.** A request from a loopback address or from
  one of the computer's own addresses gets 403 before its token is read, so a command that finds the token
  cannot drive the browser around the gateway or watch it through `/stream`. What remains: commands run as
  the same user as the computer's own process, so they can read its environment and memory
  (`/proc/<pid>/environ`, and likely `ptrace`), and `setsid` lets a command leave its process group and
  outlive its time limit or a Stop. The same user also reaches the browser two more ways. Xvfb's socket in
  `/tmp/.X11-unix` asks for no X authority, so a command can watch the screen and send it keys and clicks.
  The Chromium profile in `/tmp/aobot-browser-*` holds the cookies of every site the Bot is signed in to.
  Running commands as a separate user, or in a sidecar, closes all of these (see `docs/backlog/later.md`).
- **Grafana cannot relay a command to `/act`.** `grafana/otel-lgtm` shares the computers network, because
  the computer exports its spans there, so its requests come from an address `/act` accepts. Its image
  makes every visitor Admin, and Admin can add a data source pointing at the computer and send requests
  through it. Compose makes visitors Viewers, who read traces and cannot add data sources, and turns off
  basic auth and the login form, so `admin/admin` does not sign in either. Any other service on the
  computers network that sends requests where it is told is the same kind of relay, and network limits
  close that (E5-3).
- **Computers run unprivileged.** The browser and shell run as a non-root user in a container with all
  capabilities dropped, `no-new-privileges`, and pids and memory limits. A page exploit or a fork bomb stays
  inside one person's computer and cannot take it over.
- **Addresses are checked after resolving.** The computer's filter checks every address a name resolves to,
  in every spelling (IPv4-mapped IPv6, NAT64), and connects only to the address it checked.
- **The audit trail cannot be rewritten.** A trigger refuses UPDATE and DELETE on audit rows, and an action
  whose audit row cannot be written does not run.
- **An approval is spent once.** It is bound to a digest of the action as it resolved and refused if that
  changes, spent by one compare-and-set move in a ledger that only moves forward, never repeated after a
  crash, closed in the audit trail however it ends, and a "No" covers every action under the same ask
  rule, `request_secret` included, until the person writes again (see
  [Asking the person](#asking-the-person)). Credentials, security settings and payments always go
  to the person, whatever the rules say (E2-6).
- **An `acp` CLI names its own Bot.** Every MCP call carries the `aobot-bot` header the `acp` runtime
  set for the turn, and the gateway grants by it, so a process on the host that reaches `/mcp` can name
  any Bot. `acp` runs only in single-user mode on loopback, the same trust every MCP call had before
  Bots existed; a per-turn token would close it.
- **Secrets are typed by the person, not the chat.** When a Bot needs a password it asks with
  `request_secret`; the person types it into a card outside the conversation that goes straight to the
  computer, and no read of the page shows it again. The audit row records that a secret was supplied and
  its length (see [Secrets](#secrets)).

### On AWS

- A Bot has a shell. On AWS a shell can reach `169.254.169.254`, which hands out the machine's IAM
  role. Require IMDSv2 with a hop limit of 1 on every node, and block that range in network policy.
  OpenBot found this the hard way: [PR #620](https://github.com/CopilotKit/openbot/pull/620).
- The Docker provider talks to the Docker socket, which is root on that machine. That is fine on a
  laptop and is replaced by the ECS or Kubernetes API on AWS.

## Reference

The OpenBot source is the reference implementation for every idea here. Its
[`docs/architecture.md`](https://github.com/CopilotKit/openbot/blob/main/docs/architecture.md) and
`charts/openbot/README.md` are the most useful starting points.
