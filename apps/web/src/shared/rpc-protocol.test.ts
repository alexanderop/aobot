import { BotRpcs, Email, SessionState } from "@aobot/domain";
import { Effect, Layer, Option, Queue, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { Atom, AtomRegistry, AtomRpc } from "effect/reactivity";
import { Socket } from "effect/socket";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { sessionSockets } from "./rpc-protocol.ts";
import { makeSession } from "./session.ts";

const registries: Array<AtomRegistry.AtomRegistry> = [];

afterEach(() => {
  registries.splice(0).forEach((registry) => registry.dispose());
});

const encodeSession = Schema.encodeSync(SessionState);

const alice = SessionState.cases.SignedIn.make({
  person: { email: Email.make("alice@example.com"), name: "Alice" },
});

const signedOut = SessionState.cases.SignedOut.make({});

/** A server's `/auth/session`, answering `answers` in turn and the last from then on, until told otherwise. */
function sessionServer(answers: ReadonlyArray<SessionState>) {
  let reads = 0;
  let told: SessionState | undefined;

  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const state = told ?? answers[Math.min(reads, answers.length - 1)] ?? signedOut;
      reads += 1;

      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(encodeSession(state)), {
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  ).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl("http://aobot.test")));

  return {
    session: makeSession(Atom.runtime(Layer.succeed(HttpClient.HttpClient, client))),
    reads: () => reads,
    answer: (state: SessionState) => {
      told = state;
    },
  };
}

/** What the page sends that the fake server answers: a ping, and a call by its id. */
const ClientFrame = Schema.TaggedUnion({ Ping: {}, Request: { id: Schema.Number } });

const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(ClientFrame));

const pong = '{"_tag":"Pong"}';

/** The server's answer to the call `id` once the page's session is gone, as it is on the wire. */
const signedOutExit = (id: number) =>
  `{"_tag":"Exit","requestId":${id},"exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"_tag":"SignedOut"}}]}}`;

/**
The server's `/rpc` as each socket the page opens meets it: it `holds` every call without an answer,
answers each `SignedOut`, or `refuses` the socket, as a browser sees a 401 upgrade.
*/
function socketServer(answer: "holds" | "signs out" | "refuses") {
  const seen = { tries: 0, open: 0, calls: 0 };

  const socket = () => {
    const pending: Array<string> = [];
    let replies: Queue.Queue<string> | undefined;

    const reply = (frame: string) =>
      replies === undefined ? pending.push(frame) : Queue.offerUnsafe(replies, frame);

    const receive = (chunk: Uint8Array | string | Socket.CloseEvent) =>
      Option.match(decodeFrame(chunk), {
        onNone: () => undefined,
        onSome: ClientFrame.match({
          Ping: () => reply(pong),
          Request: ({ id }) => {
            seen.calls += 1;

            if (answer === "signs out") reply(signedOutExit(id));
          },
        }),
      });

    return Layer.succeed(
      Socket.Socket,
      Socket.make({
        reader: Effect.gen(function* () {
          seen.tries += 1;

          if (answer === "refuses") {
            return yield* new Socket.SocketError({
              reason: new Socket.SocketOpenError({ kind: "Unknown", cause: new Error("401") }),
            });
          }

          const queue = yield* Queue.unbounded<string>();
          replies = queue;
          pending.splice(0).forEach((frame) => Queue.offerUnsafe(queue, frame));
          seen.open += 1;

          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              seen.open -= 1;
              replies = undefined;
            }),
          );

          return {
            pull: Effect.map(Queue.take(queue), (frame) => [frame] as const),
            upgrade: () => Effect.void,
          };
        }),
        writer: Effect.succeed({
          write: (chunk) => Effect.sync(() => receive(chunk)),
          writeAll: (chunks) => Effect.sync(() => chunks.forEach(receive)),
        }),
      }),
    );
  };

  return { socket, seen };
}

/**
The page as far as its sockets go: the session it reads, and the Bots asked for over a client on
`sessionSockets`, asked again every 10 ms until the server answers, as the sidebar's list is.
*/
function page(server: ReturnType<typeof sessionServer>, rpc: ReturnType<typeof socketServer>) {
  class Bots extends AtomRpc.Service<Bots>()("Bots", {
    group: BotRpcs,
    protocol: sessionSockets(server.session, rpc.socket),
  }) {}

  const list = Atom.keepAlive(
    Bots.runtime.atom(
      Effect.gen(function* () {
        const client = yield* Bots;

        return yield* client("Bots.list", undefined);
      }).pipe(Effect.retry(Schedule.spaced("10 millis"))),
    ),
  );

  const registry = AtomRegistry.make();
  registries.push(registry);
  registry.mount(server.session);
  registry.mount(list);

  return registry;
}

const pause = (millis: number) => new Promise((resolve) => setTimeout(resolve, millis));

/** Waits until `holds` is true, failing after two seconds. */
async function until(what: string, holds: () => boolean): Promise<void> {
  for (let waited = 0; !holds(); waited += 5) {
    if (waited > 2_000) throw new Error(`timed out waiting for ${what}`);
    await pause(5);
  }
}

describe("the page's RPC sockets", () => {
  it("opens none while nobody is signed in", async () => {
    const rpc = socketServer("holds");
    page(sessionServer([signedOut]), rpc);

    await pause(200);

    expect(rpc.seen.tries).toBe(0);
  });

  it("opens one for the person signed in, and closes it once the session says signed out", async () => {
    const server = sessionServer([alice]);
    const rpc = socketServer("holds");
    const registry = page(server, rpc);

    await until("the socket to open", () => rpc.seen.open === 1);
    server.answer(signedOut);
    registry.refresh(server.session);
    await until("the socket to close", () => rpc.seen.open === 0);
    await pause(200);

    expect(rpc.seen).toEqual({ tries: 1, open: 0, calls: 1 });
  });

  it("reads the session again when the server refuses a socket, and stops knocking once it says signed out", async () => {
    const server = sessionServer([alice, signedOut]);
    const rpc = socketServer("refuses");
    page(server, rpc);

    await until("the session to be read again", () => server.reads() >= 2);
    const tries = rpc.seen.tries;
    await pause(1_500);

    expect(rpc.seen.tries).toBe(tries);
  });

  it("reads the session again when a call is answered SignedOut, and asks nothing more once it says so", async () => {
    const server = sessionServer([alice, signedOut]);
    const rpc = socketServer("signs out");
    page(server, rpc);

    await until("the session to be read again and the socket closed", () => {
      return server.reads() >= 2 && rpc.seen.open === 0;
    });
    const calls = rpc.seen.calls;
    await pause(200);

    expect(rpc.seen.calls).toBe(calls);
  });
});
