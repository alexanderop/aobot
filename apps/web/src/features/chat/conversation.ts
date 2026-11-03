import { Effect, Option, Schedule, Schema, Stream } from "effect";
import type { Duration } from "effect";
import { Atom } from "effect/reactivity";
import type { BotId, ConversationId, MessageId, OpenConversation } from "@aobot/domain";
import { botList } from "../bots/public.ts";
import { ChatClient } from "./chat-client.ts";
import {
  acknowledgeDuplicate,
  appendUserMessage,
  failConnection,
  failIfStillRunning,
  initialState,
  OpenOutcome,
  receiveEvent,
  refuseForAnotherBot,
  refuseMessage,
  refuseUnknownBot,
  refuseWhilePaused,
  requestStop,
  seedFromSnapshot,
} from "./conversation-state.ts";

/** A message the person typed, with the id the page picked for it and the Bot the page has open. */
export interface Outgoing {
  readonly botId: BotId;
  readonly messageId: MessageId;
  readonly text: string;
}

/** The server crashed while opening a conversation. A defect would skip `tapError` and `retry`, so it is carried as a failure. */
class OpenCrashed extends Schema.TaggedError<OpenCrashed>()("OpenCrashed", {}) {}

/**
The conversation atoms, one family per atom. `state` is the single source of truth, and `open`, `send`
and `stop` are the only things that write it. Each family returns an atom, never a wrapper object:
`Atom.family` holds its values weakly, so a plain object would be collected between renders and the
page would silently start a second conversation state. `list` is the person's conversations, asked for
again whenever one opens, a turn ends or one is read.
*/
export function makeConversations(
  runtime: Atom.AtomRuntime<ChatClient>,
  botList: Atom.Atom<unknown>,
  reconnectEvery: Duration.Input = "2 seconds",
) {
  const state = Atom.family((_id: ConversationId) => Atom.keepAlive(Atom.make(initialState)));

  const list = Atom.keepAlive(
    runtime.atom(
      Effect.gen(function* () {
        const client = yield* ChatClient;

        return yield* client("Chat.list", undefined);
      }).pipe(Effect.retry(Schedule.spaced(reconnectEvery))),
    ),
  );

  /**
  Opens the conversation with the Bot the page picked, and answers what the server said. Keyed by the
  conversation and the Bot, compared by value. A refusal is an answer, not retried: asking again would
  not make the server know the Bot, nor give the conversation another. A Bot the server does not know
  means `botList` is out of date, so it is asked for again, once per answer.
  */
  const open = Atom.family((opening: typeof OpenConversation.Type) =>
    Atom.keepAlive(
      runtime.atom(
        Effect.gen(function* () {
          const id = opening.conversationId;
          const client = yield* ChatClient;

          return yield* client("Chat.open", opening).pipe(
            Effect.tap((snapshot) =>
              Atom.update(state(id), (current) => seedFromSnapshot(current, snapshot)),
            ),
            Effect.tap(() => Atom.refresh(list)),
            Effect.map(({ bot }) => OpenOutcome.Opened({ bot })),
            Effect.catchTags({
              UnknownBot: ({ botId }) =>
                Atom.update(state(id), (current) =>
                  refuseUnknownBot(current, botId, Option.none()),
                ).pipe(
                  Effect.andThen(Atom.refresh(botList)),
                  Effect.as(OpenOutcome.UnknownBot({ botId })),
                ),
              ConversationOfAnotherBot: ({ botId }) =>
                Effect.succeed(OpenOutcome.OfAnotherBot({ botId })),
              NotYourConversation: () => Effect.succeed(OpenOutcome.NotYours()),
            }),
          );
        }).pipe(
          Effect.catchDefect(() => Effect.fail(new OpenCrashed())),
          Effect.timeout("5 seconds"),
          Effect.tapError(() =>
            Atom.update(state(opening.conversationId), (current) =>
              failConnection(current, "Cannot reach the server."),
            ),
          ),
          Effect.retry(Schedule.spaced(reconnectEvery)),
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
            botId: outgoing.botId,
            messageId: outgoing.messageId,
            text: outgoing.text,
          }).pipe(
            Stream.runForEach((event) =>
              Atom.modify(state(id), (current) => receiveEvent(current, event)).pipe(
                Effect.flatMap((stopNow) =>
                  stopNow ? client("Chat.stop", { conversationId: id }) : Effect.void,
                ),
              ),
            ),
            Effect.catchTag("ConversationBusy", () =>
              Atom.update(state(id), (current) => refuseMessage(current, outgoing.messageId)),
            ),
            Effect.catchTag("UnknownBot", ({ botId }) =>
              Atom.update(state(id), (current) =>
                refuseUnknownBot(current, botId, Option.some(outgoing.messageId)),
              ),
            ),
            // The open asks again, so the page leaves for a conversation of the person's own.
            Effect.catchTag("NotYourConversation", () =>
              Atom.refresh(open({ conversationId: id, botId: outgoing.botId })),
            ),
            // The open asks again, so the page follows the conversation to its own Bot.
            Effect.catchTag("ConversationOfAnotherBot", ({ botId }) =>
              Atom.update(state(id), (current) =>
                refuseForAnotherBot(current, botId, outgoing.messageId),
              ).pipe(
                Effect.andThen(Atom.refresh(open({ conversationId: id, botId: outgoing.botId }))),
              ),
            ),
            Effect.catchTag("BotPaused", () =>
              Atom.update(state(id), (current) =>
                refuseWhilePaused(current, outgoing.messageId, "paused"),
              ),
            ),
            Effect.catchTag("PauseUnknown", () =>
              Atom.update(state(id), (current) =>
                refuseWhilePaused(current, outgoing.messageId, "pause_unknown"),
              ),
            ),
            Effect.catchTag("MessageAlreadySent", () =>
              Atom.update(state(id), (current) =>
                acknowledgeDuplicate(current, outgoing.messageId),
              ),
            ),
            Effect.catch(() =>
              Atom.update(state(id), (current) =>
                failConnection(current, "Cannot reach the server."),
              ),
            ),
            Effect.ensuring(
              Atom.update(state(id), failIfStillRunning).pipe(Effect.andThen(Atom.refresh(list))),
            ),
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
          const stopNow = yield* Atom.modify(state(id), requestStop);

          if (stopNow) yield* client("Chat.stop", { conversationId: id });
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

  /**
  Marks everything in the conversation as read, for a page that shows it. A read that fails leaves the
  conversation unread until the next.
  */
  const read = Atom.family((id: ConversationId) =>
    Atom.keepAlive(
      runtime.fn<void>()(() =>
        Effect.gen(function* () {
          const client = yield* ChatClient;

          yield* client("Chat.read", { conversationId: id });
          yield* Atom.refresh(list);
        }).pipe(Effect.ignore),
      ),
    ),
  );

  return { state, list, open, send, read, stop };
}

/** The conversation atoms wired to the real WebSocket client. */
export const conversation = makeConversations(ChatClient.runtime, botList);
