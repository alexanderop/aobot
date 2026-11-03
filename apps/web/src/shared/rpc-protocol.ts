import { SessionState } from "@aobot/domain";
import { BrowserSocket } from "@effect/platform-browser";
import { Effect, Equivalence, Layer, Option, Predicate } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { RpcClient, type RpcMessage, RpcSerialization } from "effect/rpc";
import type { Socket } from "effect/socket";
import { session } from "./session.ts";

/** A session the page's sockets follow: the page's own, or a fake one in a test. */
type Session = typeof session;

/** Whether `response` refuses its call because the page's session is gone. */
function signedOut(response: RpcMessage.FromServerEncoded): boolean {
  return (
    Predicate.isTagged(response, "Exit") &&
    Predicate.isTagged(response.exit, "Failure") &&
    response.exit.cause.some(
      (reason) =>
        Predicate.isTagged(reason, "Fail") && Predicate.isTagged(reason.error, "SignedOut"),
    )
  );
}

/** A protocol that never connects, so every call on it waits until someone signs in. */
const closed = Layer.effect(RpcClient.Protocol, Effect.never);

/**
The protocol of an RPC client whose socket, from `socket`, is open only while `session` says someone is
signed in, and for whom: it is built again whenever that changes, so signing out, a removal or an expiry
closes the socket, and every atom on the client waits instead of asking again. The server's refusal reads
the session again: a socket it would not open, which a browser cannot tell from a server it cannot
reach, and a call it answered `SignedOut`.
*/
export function sessionSockets(session: Session, socket: () => Layer.Layer<Socket.Socket>) {
  const openFor = Atom.make((get) =>
    Option.flatMap(
      AsyncResult.value(get(session)),
      SessionState.match({
        SignedIn: ({ person }) => Option.some(person.email),
        SingleUser: () => Option.some("single-user"),
        SignedOut: () => Option.none<string>(),
      }),
    ),
  ).pipe(Atom.withEquality(Option.makeEquivalence(Equivalence.String)));

  return (get: Atom.AtomContext) => {
    if (Option.isNone(get(openFor))) return closed;

    const readAgain = Effect.sync(() => get.registry.refresh(session));

    return Layer.effect(
      RpcClient.Protocol,
      Effect.gen(function* () {
        const protocol = yield* RpcClient.Protocol;

        return RpcClient.Protocol.of({
          ...protocol,
          run: (clientId, receive) =>
            protocol.run(clientId, (response) =>
              signedOut(response)
                ? Effect.andThen(readAgain, receive(response))
                : receive(response),
            ),
        });
      }),
    ).pipe(
      Layer.provide(
        RpcClient.layerProtocolSocket({
          retryTransientErrors: true,
          onTransientError: () => readAgain,
        }),
      ),
      Layer.provide(socket()),
      Layer.provide(RpcSerialization.layerJson),
    );
  };
}

/** The server's RPC socket on the page's own origin, JSON on the wire. Each client opens its own. */
export const rpcProtocol = sessionSockets(session, () => {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";

  return BrowserSocket.layerWebSocket(`${scheme}://${window.location.host}/rpc`);
});
