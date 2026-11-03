import { Email, SessionState, signInRefusalWords } from "@aobot/domain";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { makeSession, refusalOf, signInHref } from "./session.ts";

const registries: Array<AtomRegistry.AtomRegistry> = [];

afterEach(() => {
  registries.splice(0).forEach((registry) => registry.dispose());
});

const encodeSession = Schema.encodeSync(SessionState);

/** The session the page reads from a server that says `state`, once it has answered. */
function sessionFrom(state: SessionState) {
  const client = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(encodeSession(state)), {
          headers: { "content-type": "application/json" },
        }),
      ),
    ),
  ).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl("http://aobot.test")));

  const session = makeSession(Atom.runtime(Layer.succeed(HttpClient.HttpClient, client)));
  const registry = AtomRegistry.make();
  registries.push(registry);

  return Atom.toStream(session).pipe(
    Stream.filter((result) => !AsyncResult.isInitial(result) && !result.waiting),
    Stream.runHead,
    Effect.map((result) => Option.flatMap(result, AsyncResult.value)),
    Effect.provideService(AtomRegistry.AtomRegistry, registry),
    Effect.runPromise,
  );
}

describe("the session", () => {
  it("reads who the page is open for", async () => {
    const alice = SessionState.cases.SignedIn.make({
      person: { email: Email.make("alice@example.com"), name: "Alice" },
    });

    expect(await sessionFrom(alice)).toEqual(Option.some(alice));
  });

  it("reads a signed-out page as signed out", async () => {
    const signedOut = SessionState.cases.SignedOut.make({});

    expect(await sessionFrom(signedOut)).toEqual(Option.some(signedOut));
  });
});

describe("the sign-in screen", () => {
  it("says why the server refused the last sign-in, in its words", () => {
    expect(refusalOf("?signin=domain")).toEqual(Option.some(signInRefusalWords.domain));
    expect(refusalOf("?signin=removed&c=1")).toEqual(Option.some(signInRefusalWords.removed));
  });

  it("says nothing without a refusal, and something general for one it does not know", () => {
    expect(refusalOf("?c=1")).toEqual(Option.none());
    expect(refusalOf("?signin=constructor")).toEqual(
      Option.some("Sign-in did not work. Try again."),
    );
  });

  it("signs in to come back to the same page, without the last refusal", () => {
    expect(
      signInHref(new URL("http://localhost:3000/audit?person=alice%40example.com&signin=domain")),
    ).toBe(`/auth/sign-in?return=${encodeURIComponent("/audit?person=alice%40example.com")}`);
  });
});
