import { Effect, Stream } from "effect";
import { Atom } from "effect/reactivity";
import type { ConversationId, MessageId } from "@aobot/domain";
import { ChatClient } from "./chat-client.ts";
import {
  appendUserMessage,
  failConnection,
  failIfStillRunning,
  foldChatEvent,
  initialState,
  refuseMessage,
  seedFromSnapshot,
} from "./conversation-state.ts";

/** A message the person typed, with the id the page picked for it. */
export interface Outgoing {
  readonly messageId: MessageId;
  readonly text: string;
}

/**
One conversation's atoms: `state` is the single source of truth, and `open`, `send` and `stop` are the
only things that write it. The atoms stay alive for the page's lifetime so a run outlives a re-render.
*/
export function makeConversations(runtime: Atom.AtomRuntime<ChatClient>) {
  return Atom.family((id: ConversationId) => {
    const state = Atom.keepAlive(Atom.make(initialState));

    const open = Atom.keepAlive(
      runtime.atom(
        Effect.gen(function* () {
          const client = yield* ChatClient;
          const snapshot = yield* client("Chat.open", { conversationId: id });

          yield* Atom.set(state, seedFromSnapshot(snapshot));
        }).pipe(
          Effect.tapError(() =>
            Atom.update(state, (current) => failConnection(current, "Cannot reach the server.")),
          ),
        ),
      ),
    );

    const send = Atom.keepAlive(
      runtime.fn<Outgoing>()((outgoing) =>
        Effect.gen(function* () {
          const client = yield* ChatClient;

          yield* Atom.update(state, (current) =>
            appendUserMessage(current, outgoing.messageId, outgoing.text),
          );
          yield* client("Chat.send", {
            conversationId: id,
            messageId: outgoing.messageId,
            text: outgoing.text,
          }).pipe(
            Stream.runForEach((event) =>
              Atom.update(state, (current) => foldChatEvent(current, event)),
            ),
            Effect.catchTag("ConversationBusy", () =>
              Atom.update(state, (current) => refuseMessage(current, outgoing.messageId)),
            ),
            Effect.catch(() =>
              Atom.update(state, (current) => failConnection(current, "Cannot reach the server.")),
            ),
            Effect.ensuring(Atom.update(state, failIfStillRunning)),
          );
        }),
      ),
    );

    const stop = Atom.keepAlive(
      runtime.fn<void>()(() =>
        Effect.gen(function* () {
          const client = yield* ChatClient;

          yield* client("Chat.stop", { conversationId: id });
        }).pipe(
          Effect.catch(() =>
            Atom.update(state, (current) => failConnection(current, "Cannot reach the server.")),
          ),
        ),
      ),
    );

    return { state, open, send, stop };
  });
}

/** The conversation atoms wired to the real WebSocket client. */
export const conversation = makeConversations(ChatClient.runtime);
