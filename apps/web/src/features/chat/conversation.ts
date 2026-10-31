import { Effect, Schedule, Stream } from "effect";
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
The conversation atoms, one family per atom. `state` is the single source of truth, and `open`, `send`
and `stop` are the only things that write it. Each family returns an atom, never a wrapper object:
`Atom.family` holds its values weakly, so a plain object would be collected between renders and the
page would silently start a second conversation state.
*/
export function makeConversations(runtime: Atom.AtomRuntime<ChatClient>) {
  const state = Atom.family((_id: ConversationId) => Atom.keepAlive(Atom.make(initialState)));

  const open = Atom.family((id: ConversationId) =>
    Atom.keepAlive(
      runtime.atom(
        Effect.gen(function* () {
          const client = yield* ChatClient;
          const snapshot = yield* client("Chat.open", { conversationId: id });

          yield* Atom.set(state(id), seedFromSnapshot(snapshot));
        }).pipe(
          Effect.timeout("5 seconds"),
          Effect.tapError(() =>
            Atom.update(state(id), (current) =>
              failConnection(current, "Cannot reach the server."),
            ),
          ),
          Effect.retry(Schedule.spaced("2 seconds")),
        ),
      ),
    ),
  );

  const send = Atom.family((id: ConversationId) =>
    Atom.keepAlive(
      runtime.fn<Outgoing>()((outgoing) =>
        Effect.gen(function* () {
          const client = yield* ChatClient;

          yield* Atom.update(state(id), (current) =>
            appendUserMessage(current, outgoing.messageId, outgoing.text),
          );
          yield* client("Chat.send", {
            conversationId: id,
            messageId: outgoing.messageId,
            text: outgoing.text,
          }).pipe(
            Stream.runForEach((event) =>
              Atom.update(state(id), (current) => foldChatEvent(current, event)),
            ),
            Effect.catchTag("ConversationBusy", () =>
              Atom.update(state(id), (current) => refuseMessage(current, outgoing.messageId)),
            ),
            Effect.catch(() =>
              Atom.update(state(id), (current) =>
                failConnection(current, "Cannot reach the server."),
              ),
            ),
            Effect.ensuring(Atom.update(state(id), failIfStillRunning)),
          );
        }),
      ),
    ),
  );

  const stop = Atom.family((id: ConversationId) =>
    Atom.keepAlive(
      runtime.fn<void>()(() =>
        Effect.gen(function* () {
          const client = yield* ChatClient;

          yield* client("Chat.stop", { conversationId: id });
        }).pipe(
          Effect.catch(() =>
            Atom.update(state(id), (current) =>
              failConnection(current, "Cannot reach the server."),
            ),
          ),
        ),
      ),
    ),
  );

  return { state, open, send, stop };
}

/** The conversation atoms wired to the real WebSocket client. */
export const conversation = makeConversations(ChatClient.runtime);
