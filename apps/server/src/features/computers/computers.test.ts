import type { IncomingHttpHeaders } from "node:http";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Redacted, type Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { ComputerActFailed, ComputerLost, computerAt } from "./computers.ts";
import { reply, serve } from "./testing/serve.ts";

/** A computer that answers every `/act` with `status` and `json`, and keeps the headers it was sent. */
function fakeComputer(status: number, json: Schema.Json) {
  const seen: Array<IncomingHttpHeaders> = [];

  return serve((request, response) => {
    seen.push(request.headers);
    reply(response, status, json);
  }).pipe(Effect.map(({ port }) => ({ url: `http://127.0.0.1:${port}`, seen })));
}

const token = Redacted.make("computer-token");

function act(url: string) {
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;

    return yield* computerAt({ url, token }, client).act({ action: "snapshot" });
  }).pipe(Effect.provide(FetchHttpClient.layer));
}

describe("computerAt", () => {
  it.effect("sends the token and the caller's trace, and reads the result", () =>
    Effect.gen(function* () {
      const computer = yield* fakeComputer(200, {
        action: "snapshot",
        url: "https://example.com/",
        title: "Example Domain",
        snapshot: '- heading "Example Domain" [ref=e1]',
        truncated: false,
      });

      const [result, traceId] = yield* Effect.all([act(computer.url), Effect.currentSpan]).pipe(
        Effect.map(([answer, span]) => [answer, span.traceId] as const),
        Effect.withSpan("Gateway.act"),
      );

      expect(result).toMatchObject({ action: "snapshot", title: "Example Domain" });
      expect(computer.seen[0]?.authorization).toBe("Bearer computer-token");
      expect(computer.seen[0]?.traceparent).toMatch(
        new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`, "u"),
      );
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    [403, "refused"],
    [502, "failed"],
  ] as const)("reads status %i as the computer saying it did not do it", ([status, reason]) =>
    Effect.gen(function* () {
      const computer = yield* fakeComputer(status, { reason, message: "no" });

      expect(yield* Effect.flip(act(computer.url))).toEqual(
        new ComputerActFailed({ reason, message: "no" }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("reads a token the computer turned away as refused: it never tried", () =>
    Effect.gen(function* () {
      const computer = yield* fakeComputer(401, { message: "token" });

      expect(yield* Effect.flip(act(computer.url))).toMatchObject({ reason: "refused" });
    }).pipe(Effect.scoped),
  );

  it.effect("reads a crash or a reply it cannot read as not knowing whether it happened", () =>
    Effect.gen(function* () {
      const crashed = yield* fakeComputer(500, { message: "boom" });
      const garbled = yield* fakeComputer(200, { nothing: "useful" });

      expect(yield* Effect.flip(act(crashed.url))).toBeInstanceOf(ComputerLost);
      expect(yield* Effect.flip(act(garbled.url))).toBeInstanceOf(ComputerLost);
    }).pipe(Effect.scoped),
  );
});
