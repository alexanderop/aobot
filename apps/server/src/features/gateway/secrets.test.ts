import {
  ConversationId,
  NoSecretRequested,
  type PageAction,
  type PageRead,
  type PendingSecret,
  RunId,
  SecretAnswer,
  SecretRequestId,
} from "@aobot/domain";
import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Context,
  Effect,
  Fiber,
  Layer,
  Option,
  Redacted,
  Schedule,
  type Schema,
  Stream,
} from "effect";
import { HttpMiddleware, HttpRouter, HttpServer } from "effect/http";
import { TestClock } from "effect/testing";
import { recordedSpans } from "../../shared/testing/recorded-spans.ts";
import { assistant } from "../bots/testing/test-bots.ts";
import { policyFrom } from "../policy/testing/test-policy.ts";
import { ApprovalRequests } from "./approvals.ts";
import { ComputerControl } from "./control.ts";
import { Claim, Gateway } from "./gateway.ts";
import { gatewayMcpLayer, turnHeaders } from "./mcp.ts";
import { secretRequests, SecretRequests } from "./secrets.ts";
import {
  database,
  decodedTrail as trail,
  fakeComputers,
  startGateway,
} from "./testing/test-gateway.ts";

const password = "hunter2-password";

const signIn = `- generic [ref=e1]:
  - textbox "User" [ref=e2]: ada
  - textbox "Password" [ref=e3]
  - button "Sign in" [ref=e4]`;

/** The sign-in page a Bot reads at `url`, and every action the computer was sent. */
function signInComputer(url = "https://shop.example/login") {
  return fakeComputers({
    browse: (action: PageAction): Effect.Effect<PageRead> =>
      Effect.succeed({
        action: action.action,
        url,
        title: "Sign in",
        snapshot:
          action.action === "type_secret"
            ? signIn.replace('"Password" [ref=e3]', '"Password" [ref=e3]: "[hidden]"')
            : signIn,
        truncated: false,
      }),
  });
}

const askForPassword = {
  action: "request_secret",
  ref: "e3",
  field: "the password for shop.example",
} as const;

/** Reads the sign-in page, then asks for its password in a fiber of its own. */
const readThenAsk = Gateway.use((gateway) =>
  gateway
    .act(bot, { action: "snapshot" })
    .pipe(Effect.andThen(Effect.forkChild(gateway.act(bot, askForPassword)))),
);

/** The request the person is shown, once the Bot's request waits for them. */
const untilShown = SecretRequests.use((secrets) =>
  secrets.pending(assistant.id).pipe(
    Stream.filter(Option.isSome),
    Stream.runHead,
    Effect.map((shown) => Option.getOrThrow(Option.flatten(shown))),
  ),
);

/** The person's answer to `shown`. */
const answerTo = (shown: PendingSecret, answer: SecretAnswer) =>
  SecretRequests.use((secrets) => secrets.answer(assistant.id, shown.request, answer));

/** The person's answer, once the Bot's request waits for it. */
const answerOnceShown = (answer: SecretAnswer) =>
  Effect.flatMap(untilShown, (shown) => answerTo(shown, answer));

const supplied = SecretAnswer.cases.Supplied.make({ value: Redacted.make(password) });

/** The person's answer to `shown` once it is no longer waiting. */
const answerLate = (shown: PendingSecret) => Effect.flip(answerTo(shown, supplied));

/** Whether the person is shown any request of the Bot's now. */
const shownNow = SecretRequests.use((secrets) =>
  secrets.pending(assistant.id).pipe(Stream.runHead, Effect.map(Option.flatten)),
);

const conversation = ConversationId.make("conversation-1");

/** The assistant's call in run `run` of the conversation. */
const inRun = (run: string) =>
  Claim.cases.Named.make({ bot: assistant.id, turn: { conversation, run: RunId.make(run) } });

const inTurn = inRun("run-1");

const bot = inTurn;

const askBeforeTyping = policyFrom(`deny: []
allow:
  - name: granted-tools
    when: "true"
ask:
  - name: ask-before-typing
    when: element.role == "textbox"
`);

/** The approval card the person is shown in the conversation now, if any. */
const approvalShownNow = ApprovalRequests.use((approvals) =>
  approvals.pending(conversation).pipe(Stream.runHead, Effect.map(Option.flatten)),
);

/** What the model reads of a call under `ask-before-typing` after a no to that rule in its run. */
const declinedEarlier = (tool: string) =>
  `${tool} did not run: your person already said no to this in this conversation. Do not ask again until they write to you.`;

describe("request_secret", () => {
  it.effect("types what the person supplied into the field, and no row or span holds it", () =>
    Effect.gen(function* () {
      const computer = signInComputer();
      const tracing = recordedSpans();

      const [shown, answer] = yield* Effect.gen(function* () {
        const asking = yield* readThenAsk;
        const shown = yield* untilShown;
        yield* answerTo(shown, supplied);

        return [shown, yield* Fiber.join(asking)] as const;
      }).pipe(Effect.provide(startGateway(computer.layer)), Effect.provide(tracing.layer));

      expect(shown).toEqual({
        request: expect.any(String),
        field: "the password for shop.example",
        host: "shop.example",
      });
      expect(answer).toContain('Your person typed "the password for shop.example" into e3.');
      expect(answer).toContain('<untrusted_data source="web page">');
      expect(answer).toContain('textbox "Password" [ref=e3]: "[hidden]"');
      expect(answer).not.toContain(password);

      const typed = computer.actions.at(-1);
      expect(typed).toMatchObject({
        action: "type_secret",
        target: { ref: "e3", role: "textbox", name: "Password" },
      });
      expect(typed?.action === "type_secret" && Redacted.value(typed.secret)).toBe(password);

      const element = { ref: "e3", role: "textbox", name: "Password", host: "shop.example" };
      const field = "the password for shop.example";

      expect((yield* trail).slice(2)).toEqual([
        ["secret.requested · allow", { bot: "assistant", ...element, field, rule: "everything" }],
        ["secret.requested · succeeded", { bot: "assistant" }],
        [
          "secret.supplied · allow",
          { bot: "assistant", ...element, field, chars: password.length, rule: "everything" },
        ],
        ["secret.supplied · succeeded", { bot: "assistant" }],
      ]);

      const recorded = tracing.spans.map((span) => [span.name, [...span.attributes]]);
      expect(recorded.length).toBeGreaterThan(0);
      expect(JSON.stringify(recorded)).not.toContain(password);
      expect(JSON.stringify(yield* trail)).not.toContain(password);
    }).pipe(Effect.provide(database)),
  );

  it.effect("asks no second question of a secret an ask rule holds for, and names the rule", () =>
    Effect.gen(function* () {
      const computer = signInComputer();

      const policy = policyFrom(`deny: []
allow:
  - name: granted-tools
    when: "true"
ask:
  - name: ask-for-secrets
    when: tool.name == "request_secret"
`);

      yield* Effect.gen(function* () {
        const asking = yield* readThenAsk;
        yield* answerOnceShown(supplied);
        yield* Fiber.join(asking);
      }).pipe(Effect.provide(startGateway(computer.layer, policy)));

      expect((yield* trail).filter(([row]) => row === "secret.requested · allow")).toEqual([
        [
          "secret.requested · allow",
          {
            bot: "assistant",
            ref: "e3",
            role: "textbox",
            name: "Password",
            host: "shop.example",
            field: "the password for shop.example",
            rule: "granted-tools",
            asked: "ask-for-secrets",
          },
        ],
      ]);
      expect(computer.actions.at(-1)?.action).toBe("type_secret");
    }).pipe(Effect.provide(database)),
  );

  it.effect("refuses a secret under an ask rule its person said no to, in that run", () =>
    Effect.gen(function* () {
      const computer = signInComputer();

      const [refused, shownAfter] = yield* Effect.gen(function* () {
        yield* Gateway.use((gateway) => gateway.act(inTurn, { action: "snapshot" }));

        const typing = yield* Gateway.use((gateway) =>
          Effect.forkChild(
            Effect.result(gateway.act(inTurn, { action: "type", ref: "e2", text: "grace" })),
          ),
        );

        yield* ApprovalRequests.use((approvals) =>
          approvals.pending(conversation).pipe(
            Stream.filter(Option.isSome),
            Stream.runHead,
            Effect.flatMap((shown) =>
              approvals.answer(
                conversation,
                Option.getOrThrow(Option.flatten(shown)).approval,
                "no",
              ),
            ),
          ),
        );
        yield* Fiber.join(typing);

        const refused = yield* Gateway.use((gateway) =>
          Effect.flip(gateway.act(inTurn, askForPassword)),
        );

        return [refused, yield* shownNow] as const;
      }).pipe(Effect.provide(startGateway(computer.layer, askBeforeTyping)));

      expect(refused.message).toBe(declinedEarlier("request_secret"));
      expect(shownAfter).toEqual(Option.none());
      expect((yield* trail).at(-1)).toEqual([
        "secret.requested · deny",
        {
          bot: "assistant",
          ref: "e3",
          role: "textbox",
          name: "Password",
          host: "shop.example",
          field: "the password for shop.example",
          rule: "ask-before-typing",
          reason: "declined earlier",
        },
      ]);
      expect(computer.actions.map((action) => action.action)).toEqual(["snapshot"]);
    }).pipe(Effect.provide(database)),
  );

  it.effect("shows no approval card beside a secret card an ask rule holds for", () =>
    Effect.gen(function* () {
      const computer = signInComputer();

      const [refused, cardShown] = yield* Effect.gen(function* () {
        yield* Gateway.use((gateway) => gateway.act(inTurn, { action: "snapshot" }));

        const asking = yield* Gateway.use((gateway) =>
          Effect.forkChild(gateway.act(inTurn, askForPassword)),
        );

        yield* untilShown;

        const refused = yield* Gateway.use((gateway) =>
          Effect.flip(gateway.act(inTurn, { action: "type", ref: "e2", text: "grace" })),
        );

        const cardShown = yield* approvalShownNow;

        yield* answerOnceShown(supplied);
        yield* Fiber.join(asking);

        return [refused, cardShown] as const;
      }).pipe(Effect.provide(startGateway(computer.layer, askBeforeTyping)));

      expect(refused.message).toBe(
        "type did not run: you already asked your person and they have not answered. Wait for that answer.",
      );
      expect(cardShown).toEqual(Option.none());
      expect(computer.actions.map(({ action }) => action)).toEqual(["snapshot", "type_secret"]);
    }).pipe(Effect.provide(database)),
  );

  it.effect.each([
    [
      "declines it",
      (shown: PendingSecret) => answerTo(shown, SecretAnswer.cases.Declined.make({})),
    ],
    ["does not answer it in time", () => TestClock.adjust("10 minutes")],
  ] as const)(
    "takes a person who %s under an ask rule as a no to that rule for the rest of the run",
    ([, unanswered]) =>
      Effect.gen(function* () {
        const computer = signInComputer();

        const [secretAgain, typing, shownAfter, nextRun] = yield* Effect.gen(function* () {
          yield* Gateway.use((gateway) => gateway.act(inTurn, { action: "snapshot" }));

          const asking = yield* Gateway.use((gateway) =>
            Effect.forkChild(Effect.result(gateway.act(inTurn, askForPassword))),
          );

          yield* unanswered(yield* untilShown);
          yield* Fiber.join(asking);

          const secretAgain = yield* Gateway.use((gateway) =>
            Effect.flip(gateway.act(inTurn, askForPassword)),
          );

          const typing = yield* Gateway.use((gateway) =>
            Effect.flip(gateway.act(inTurn, { action: "type", ref: "e2", text: "grace" })),
          );

          const shownAfter = [yield* shownNow, yield* approvalShownNow];

          const askingNextRun = yield* Gateway.use((gateway) =>
            Effect.forkChild(Effect.result(gateway.act(inRun("run-2"), askForPassword))),
          );

          const nextRun = yield* untilShown;
          yield* answerTo(nextRun, supplied);
          yield* Fiber.join(askingNextRun);

          return [secretAgain, typing, shownAfter, nextRun] as const;
        }).pipe(Effect.provide(startGateway(computer.layer, askBeforeTyping)));

        expect(secretAgain.message).toBe(declinedEarlier("request_secret"));
        expect(typing.message).toBe(declinedEarlier("type"));
        expect(shownAfter).toEqual([Option.none(), Option.none()]);
        expect(nextRun.field).toBe("the password for shop.example");
        expect(computer.actions.map(({ action }) => action)).toEqual(["snapshot", "type_secret"]);
      }).pipe(Effect.provide(database)),
  );

  it.effect("takes no answer for another request than the one waiting", () =>
    Effect.gen(function* () {
      const computer = signInComputer();

      const [refused, answer] = yield* Effect.gen(function* () {
        const asking = yield* readThenAsk;
        const shown = yield* untilShown;
        const other = { ...shown, request: SecretRequestId.make("another-request") };
        const refused = yield* answerLate(other);
        yield* answerTo(shown, supplied);

        return [refused, yield* Fiber.join(asking)] as const;
      }).pipe(Effect.provide(startGateway(computer.layer)));

      expect(refused).toBeInstanceOf(NoSecretRequested);
      expect(answer).toContain("Your person typed");
    }).pipe(Effect.provide(database)),
  );

  it.effect("tells the model the person declined, and types nothing", () =>
    Effect.gen(function* () {
      const computer = signInComputer();

      const refused = yield* Effect.gen(function* () {
        const asking = yield* readThenAsk;
        yield* answerOnceShown(SecretAnswer.cases.Declined.make({}));

        return yield* Effect.flip(Fiber.join(asking));
      }).pipe(Effect.provide(startGateway(computer.layer)));

      expect(refused.message).toContain(
        'Your person declined to type "the password for shop.example"',
      );
      expect(computer.actions.map(({ action }) => action)).toEqual(["snapshot"]);
      expect((yield* trail).slice(3)).toEqual([
        ["secret.requested · failed", { bot: "assistant", reason: "declined" }],
      ]);
    }).pipe(Effect.provide(database)),
  );

  it.effect("gives up after ten minutes without an answer, and then takes none", () =>
    Effect.gen(function* () {
      const computer = signInComputer();

      const [refused, late, after] = yield* Effect.gen(function* () {
        const asking = yield* readThenAsk;
        const shown = yield* untilShown;
        yield* TestClock.adjust("10 minutes");
        const refused = yield* Effect.flip(Fiber.join(asking));

        return [refused, yield* answerLate(shown), yield* shownNow] as const;
      }).pipe(Effect.provide(startGateway(computer.layer)));

      expect(refused.message).toContain("Your person did not answer within 10m");
      expect(late).toBeInstanceOf(NoSecretRequested);
      expect(after).toEqual(Option.none());
      expect(computer.actions.map(({ action }) => action)).toEqual(["snapshot"]);
      expect((yield* trail).slice(3)).toEqual([
        ["secret.requested · failed", { bot: "assistant", reason: "no answer" }],
      ]);
    }).pipe(Effect.provide(database)),
  );

  it.effect("records the request failed when the turn stops while it waits", () =>
    Effect.gen(function* () {
      const computer = signInComputer();

      const late = yield* Effect.gen(function* () {
        const asking = yield* readThenAsk;
        const shown = yield* untilShown;
        yield* Fiber.interrupt(asking);

        return yield* answerLate(shown);
      }).pipe(Effect.provide(startGateway(computer.layer)));

      expect(late).toBeInstanceOf(NoSecretRequested);
      expect(computer.actions.map(({ action }) => action)).toEqual(["snapshot"]);
      expect((yield* trail).slice(3)).toEqual([
        ["secret.requested · failed", { bot: "assistant", reason: "the turn was stopped" }],
      ]);
    }).pipe(Effect.provide(database)),
  );

  it.effect("refuses a second request while the first waits", () =>
    Effect.gen(function* () {
      const computer = signInComputer();

      const refused = yield* Effect.gen(function* () {
        const asking = yield* readThenAsk;
        yield* untilShown;

        const second = yield* Gateway.use((gateway) =>
          Effect.flip(gateway.act(bot, askForPassword)),
        );

        yield* Fiber.interrupt(asking);

        return second;
      }).pipe(Effect.provide(startGateway(computer.layer)));

      expect(refused.message).toContain("you already asked your person for a secret");
      expect((yield* trail).at(-2)).toEqual([
        "secret.requested · deny",
        { bot: "assistant", reason: "already asked" },
      ]);
    }).pipe(Effect.provide(database)),
  );

  it.effect("judges the request by the element its ref names, before asking anyone", () =>
    Effect.gen(function* () {
      const computer = signInComputer();

      const policy = policyFrom(`deny:
  - name: no-passwords-here
    when: tool.name == "request_secret" && element.name == "Password" && page.host == "shop.example"
allow:
  - name: granted-tools
    when: "true"
`);

      const [refused, nobodyAsked] = yield* Gateway.use((gateway) =>
        gateway.act(bot, { action: "snapshot" }).pipe(
          Effect.andThen(Effect.flip(gateway.act(bot, askForPassword))),
          Effect.flatMap((refused) => Effect.map(shownNow, (none) => [refused, none] as const)),
        ),
      ).pipe(Effect.provide(startGateway(computer.layer, policy)));

      expect(refused.message).toContain("the rule no-passwords-here refuses it");
      expect(nobodyAsked).toEqual(Option.none());
      expect((yield* trail).at(-1)).toEqual([
        "secret.requested · deny",
        {
          bot: "assistant",
          ref: "e3",
          role: "textbox",
          name: "Password",
          host: "shop.example",
          field: "the password for shop.example",
          rule: "no-passwords-here",
          reason: "denied by rule",
        },
      ]);
    }).pipe(Effect.provide(database)),
  );

  it.effect("refuses a request for an element that is no text field, and asks nobody", () =>
    Effect.gen(function* () {
      const computer = signInComputer();

      const [refused, nobodyAsked] = yield* Gateway.use((gateway) =>
        gateway.act(bot, { action: "snapshot" }).pipe(
          Effect.andThen(Effect.flip(gateway.act(bot, { ...askForPassword, ref: "e4" }))),
          Effect.flatMap((refused) => Effect.map(shownNow, (none) => [refused, none] as const)),
        ),
      ).pipe(Effect.provide(startGateway(computer.layer)));

      expect(refused.message).toBe(
        "request_secret did not run: e4 is a button, not a text field. Ask for a secret only for a textbox or a searchbox.",
      );
      expect(nobodyAsked).toEqual(Option.none());
      expect(computer.actions.map(({ action }) => action)).toEqual(["snapshot"]);
      expect((yield* trail).at(-1)).toEqual([
        "secret.requested · deny",
        {
          bot: "assistant",
          ref: "e4",
          role: "button",
          name: "Sign in",
          host: "shop.example",
          field: "the password for shop.example",
          reason: "not a text field",
        },
      ]);
    }).pipe(Effect.provide(database)),
  );

  it.effect.each(["about:blank", "data:text/html,<input>"])(
    "refuses a request on %s, a page on no site, and asks nobody",
    (url) =>
      Effect.gen(function* () {
        const computer = signInComputer(url);

        const [refused, nobodyAsked] = yield* Gateway.use((gateway) =>
          gateway.act(bot, { action: "snapshot" }).pipe(
            Effect.andThen(Effect.flip(gateway.act(bot, askForPassword))),
            Effect.flatMap((refused) => Effect.map(shownNow, (none) => [refused, none] as const)),
          ),
        ).pipe(Effect.provide(startGateway(computer.layer)));

        expect(refused.message).toBe(
          "request_secret did not run: the page e3 is on has no site, so your person could not tell where the secret goes. Ask for a secret only on a page of the site it is for.",
        );
        expect(nobodyAsked).toEqual(Option.none());
        expect(computer.actions.map(({ action }) => action)).toEqual(["snapshot"]);
        expect((yield* trail).at(-1)).toEqual([
          "secret.requested · deny",
          {
            bot: "assistant",
            ref: "e3",
            role: "textbox",
            name: "Password",
            host: "",
            field: "the password for shop.example",
            reason: "no site",
          },
        ]);
      }).pipe(Effect.provide(database)),
  );

  it.effect("lets a person take the computer while the Bot waits, and then types nothing", () =>
    Effect.gen(function* () {
      const computer = signInComputer();

      const refused = yield* Effect.gen(function* () {
        const asking = yield* readThenAsk;
        const shown = yield* untilShown;
        yield* ComputerControl.use((control) => control.take);
        yield* answerTo(shown, supplied);

        return yield* Effect.flip(Fiber.join(asking));
      }).pipe(Effect.provide(startGateway(computer.layer)));

      expect(refused.message).toContain("a person has control of your computer now");
      expect(computer.actions.map(({ action }) => action)).toEqual(["snapshot"]);
      expect((yield* trail).slice(-2)).toEqual([
        ["secret.requested · succeeded", { bot: "assistant" }],
        ["secret.supplied · deny", { bot: "assistant", reason: "a person has control" }],
      ]);
    }).pipe(Effect.provide(database)),
  );
});

describe("secretRequests", () => {
  /** The request `bot` waits on now, as its person is shown it. */
  const shownBy = (requests: SecretRequests["Service"]) =>
    requests.pending(assistant.id).pipe(Stream.runHead, Effect.map(Option.flatten));

  it.effect("withdraws a request the moment its wait runs out, before the scope closes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { open, requests } = yield* secretRequests;
        const request = yield* open(assistant.id);
        yield* request.ask("the password", "shop.example");
        const shown = Option.getOrThrow(yield* shownBy(requests));

        const waiting = yield* Effect.forkChild(request.wait("10 minutes"));
        yield* TestClock.adjust("10 minutes");

        expect(yield* Fiber.join(waiting)).toEqual(Option.none());
        expect(yield* Effect.flip(requests.answer(assistant.id, shown.request, supplied))).toEqual(
          new NoSecretRequested({
            message: "The Bot is not waiting for that secret any more, so nothing was typed.",
          }),
        );
      }),
    ),
  );

  it.effect("takes no answer for a request held while its ref is judged, before it is shown", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { open, requests } = yield* secretRequests;
        yield* open(assistant.id);

        expect(yield* shownBy(requests)).toEqual(Option.none());
      }),
    ),
  );
});

/** A JSON-RPC request, or a notification when it has no `id`. */
interface RpcMessage {
  readonly id?: number;
  readonly method: string;
  readonly params?: Schema.Json;
}

/** A message a CLI posts to the gateway's MCP server, and the signal that aborts its request. */
type Post = (message: RpcMessage, signal?: AbortSignal) => Promise<Response>;

/** An MCP session for the assistant over HTTP at `url`, as an `acp` CLI opens one. */
async function mcpSession(url: string): Promise<Post> {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...Object.fromEntries(
      turnHeaders({ bot: assistant.id, conversation, run: RunId.make("run-1") }).map(
        ({ name, value }) => [name, value],
      ),
    ),
  };

  const post =
    (sent: Record<string, string>): Post =>
    (message, signal) =>
      fetch(url, {
        method: "POST",
        headers: sent,
        body: JSON.stringify({ jsonrpc: "2.0", ...message }),
        signal: signal ?? null,
      });

  const opened = await post(headers)({
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test-cli", version: "0.0.0" },
    },
  });

  await opened.text();

  const session = post({
    ...headers,
    "mcp-session-id": opened.headers.get("mcp-session-id") ?? "",
    "mcp-protocol-version": "2025-06-18",
  });

  await (await session({ method: "notifications/initialized" })).text();

  return session;
}

/** The gateway's MCP server on a free port, as the server serves it, and its address. */
const serveMcp = Effect.gen(function* () {
  const served = yield* Layer.build(
    HttpRouter.serve(gatewayMcpLayer).pipe(
      Layer.provideMerge(startGateway(signInComputer().layer)),
      Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
      Layer.provide(Layer.succeed(HttpMiddleware.TracerDisabledWhen, () => true)),
    ),
  );

  return {
    served,
    url: `${HttpServer.formatAddress(Context.get(served, HttpServer.HttpServer).address)}/mcp`,
  };
});

/** The trail once its last row settles the request, polled, since the row is written after the wait ends. */
const untilSettled = trail.pipe(
  Effect.repeat({
    until: (rows) => rows.at(-1)?.[0] === "secret.requested · failed",
    schedule: Schedule.spaced("50 millis"),
  }),
  Effect.timeout("5 seconds"),
);

/** How a CLI stops its call: through `session`, or by aborting `call`'s request. */
type StopCall = (session: Post, call: AbortController) => Promise<void>;

const stops: ReadonlyArray<readonly [string, StopCall]> = [
  [
    "cancels the call",
    async (session) => {
      await session({
        method: "notifications/cancelled",
        params: { requestId: 3, reason: "timeout" },
      });
    },
  ],
  ["closes the call's connection", async (_, call) => call.abort()],
];

describe("request_secret over MCP", () => {
  it.live.each(stops)("ends the wait at once when the CLI %s", ([, stop]) =>
    Effect.gen(function* () {
      const { served, url } = yield* serveMcp;
      const session = yield* Effect.promise(() => mcpSession(url));
      const call = new AbortController();

      yield* Effect.promise(() =>
        session({ id: 2, method: "tools/call", params: { name: "snapshot", arguments: {} } }).then(
          (answered) => answered.text(),
        ),
      );

      const asking = session(
        {
          id: 3,
          method: "tools/call",
          params: { name: "request_secret", arguments: { ref: "e3", field: "the password" } },
        },
        call.signal,
      ).catch(() => "aborted");

      const shownFirst = yield* untilShown.pipe(Effect.provideContext(served));

      yield* Effect.promise(() => stop(session, call));

      const rows = yield* untilSettled;
      const shownAfter = yield* shownNow.pipe(Effect.provideContext(served));

      call.abort();
      yield* Effect.promise(() => asking);

      expect(shownFirst.field).toBe("the password");
      expect(shownAfter).toEqual(Option.none());
      expect(rows.at(-1)).toEqual([
        "secret.requested · failed",
        { bot: "assistant", reason: "the turn was stopped" },
      ]);
    }).pipe(Effect.provide(database), Effect.scoped),
  );
});
