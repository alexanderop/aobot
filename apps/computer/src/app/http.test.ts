import type { PageAction } from "@aobot/domain";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { Effect, Layer, Option, Redacted } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { ActionFailed, ActionRefused, Browser } from "../features/browser/public.ts";
import { CommandFailed, Shell } from "../features/shell/public.ts";
import { routesLayer } from "./http.ts";

const token = "computer-token";

const fakeBrowser = Layer.succeed(
  Browser,
  Browser.of({
    act: (action: PageAction) =>
      Effect.gen(function* () {
        if (action.action !== "navigate")
          return yield* new ActionFailed({ message: "Chromium crashed." });

        if (action.url.startsWith("file:")) {
          return yield* new ActionRefused({ message: "Only http and https addresses open." });
        }

        // The span the browser runs in, and its parent, so the test can see the trace the caller sent.
        const span = yield* Effect.orDie(Effect.currentSpan);

        const parent = Option.match(span.parent, {
          onNone: () => "no parent",
          onSome: (outer) => `${outer.traceId}/${outer.spanId}`,
        });

        return {
          action: "navigate",
          url: action.url,
          title: `${span.name} under ${parent}`,
          snapshot: '- heading "Example Domain" [level=1] [ref=e1]',
          truncated: false,
        } as const;
      }),
  }),
);

/** A shell that echoes the command it was given, and cannot start bash for `crash`. */
const fakeShell = Layer.succeed(
  Shell,
  Shell.of({
    run: (command) =>
      command === "crash"
        ? Effect.fail(new CommandFailed({ message: "bash would not start." }))
        : Effect.succeed({
            action: "run",
            exitCode: 0,
            stdout: `${command}\n`,
            stderr: "",
            truncated: false,
            timedOut: false,
          }),
  }),
);

const app = HttpRouter.toWebHandler(
  routesLayer(Redacted.make(token)).pipe(
    Layer.provideMerge(Layer.merge(fakeBrowser, fakeShell)),
    Layer.provide(HttpServer.layerServices),
  ),
  { disableLogger: true },
);

afterAll(() => app.dispose());

function act(body: string, headers: Record<string, string>) {
  return app.handler(
    new Request("http://computer/act", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
  );
}

const navigate = JSON.stringify({ action: "navigate", url: "https://example.com/" });

const bearer = { authorization: `Bearer ${token}` };

describe("GET /health", () => {
  it("answers without a token", async () => {
    const response = await app.handler(new Request("http://computer/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});

describe("POST /act", () => {
  it.each([
    ["no token", {}],
    ["the wrong token", { authorization: "Bearer computer-tokeN" }],
    ["a non-ASCII token", { authorization: "Bearer computer-tökén" }],
    ["the token without Bearer", { authorization: token }],
  ])("answers 401 to %s", async (_, headers) => {
    const response = await act(navigate, headers);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Not authorised." });
  });

  it("carries out an action and answers with its result", async () => {
    const response = await act(navigate, bearer);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      action: "navigate",
      url: "https://example.com/",
      title: "Computer.act under no parent",
      snapshot: '- heading "Example Domain" [level=1] [ref=e1]',
      truncated: false,
    });
  });

  it("runs the action inside the caller's trace", async () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const spanId = "00f067aa0ba902b7";
    const response = await act(navigate, { ...bearer, traceparent: `00-${traceId}-${spanId}-01` });
    expect(await response.json()).toMatchObject({
      title: `Computer.act under ${traceId}/${spanId}`,
    });
  });

  it("answers 403 refused when the computer will not try", async () => {
    const response = await act(
      JSON.stringify({ action: "navigate", url: "file:///etc/passwd" }),
      bearer,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      reason: "refused",
      message: "Only http and https addresses open.",
    });
  });

  it("answers 502 failed when the browser fails", async () => {
    const response = await act(JSON.stringify({ action: "snapshot" }), bearer);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ reason: "failed", message: "Chromium crashed." });
  });

  it("runs a command in the shell and answers how it ended", async () => {
    const response = await act(JSON.stringify({ action: "run", command: "echo hi" }), bearer);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      action: "run",
      exitCode: 0,
      stdout: "echo hi\n",
      stderr: "",
      truncated: false,
      timedOut: false,
    });
  });

  it("answers 502 failed when the shell cannot run a command", async () => {
    const response = await act(JSON.stringify({ action: "run", command: "crash" }), bearer);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ reason: "failed", message: "bash would not start." });
  });

  it.each([
    JSON.stringify({ action: "run" }),
    "not json",
    JSON.stringify({ action: "click" }),
    JSON.stringify({ action: "navigate" }),
  ])("answers 400 to the body %s", async (body) => {
    expect((await act(body, bearer)).status).toBe(400);
  });
});
