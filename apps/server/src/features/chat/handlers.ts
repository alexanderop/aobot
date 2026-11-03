import {
  type BotId,
  Caller,
  type ChatEvent,
  ChatRpcs,
  type ConversationId,
  ConversationOfAnotherBot,
  type ConversationRef,
  type Message,
  MessageAlreadySent,
  MessageId,
  type OpenConversation,
  RunId,
  type SendMessage,
  UnknownBot,
} from "@aobot/domain";
import { Deferred, Effect, Option, Ref, Stream } from "effect";
import { actorId } from "../../shared/actor.ts";
import { AgentRuntime } from "../agent/public.ts";
import { Bots, botSummary, turnInstructions } from "../bots/public.ts";
import { Turns } from "../lifecycle/public.ts";
import { ConversationStore } from "./conversation-store.ts";
import { isTerminal, turnEvents, turnStatus } from "./turn.ts";

/** The Bot's messages so far with one more streamed event folded in: text grows the message it names. */
function recordText(messages: ReadonlyArray<Message>, event: ChatEvent): ReadonlyArray<Message> {
  if (event.type !== "TEXT_MESSAGE_CONTENT") return messages;

  const last = messages.at(-1);

  return last?.id === event.messageId
    ? [...messages.slice(0, -1), { ...last, text: last.text + event.delta }]
    : [...messages, { id: event.messageId, role: "assistant", text: event.delta }];
}

/** The chat API: open a conversation, send a message and watch the answer stream, stop a turn. */
export const chatHandlersLayer = ChatRpcs.toLayer(
  Effect.gen(function* () {
    const store = yield* ConversationStore;
    const agent = yield* AgentRuntime;
    const bots = yield* Bots;
    const turns = yield* Turns;

    /**
    The Bot the page picked, unless the conversation belongs to another. A Bot no longer in `bots.yaml` is
    unknown, so its old conversations open no more.
    */
    const botOf = Effect.fnUntraced(function* (conversationId: ConversationId, picked: BotId) {
      const own = yield* store.bot(conversationId);

      if (Option.isSome(own) && own.value !== picked) {
        return yield* new ConversationOfAnotherBot({ conversationId, botId: own.value });
      }

      return yield* Option.match(bots.get(picked), {
        onNone: () => Effect.fail(new UnknownBot({ botId: picked })),
        onSome: Effect.succeed,
      });
    });

    const open = Effect.fn("Chat.open")(function* ({
      conversationId,
      botId,
    }: typeof OpenConversation.Type) {
      const bot = yield* botOf(conversationId, botId);
      const messages = yield* store.messages(conversationId);

      return {
        bot: botSummary(bot),
        messages,
        isRunning: yield* turns.isRunning(conversationId),
      };
    });

    const startTurn = Effect.fn("Chat.send")(function* (message: typeof SendMessage.Type) {
      const { conversationId } = message;

      const ids = {
        conversationId,
        runId: RunId.make(crypto.randomUUID()),
        messageId: MessageId.make(crypto.randomUUID()),
      };

      const actor = yield* Caller;

      const bot = yield* botOf(conversationId, message.botId);

      const { stopped, recordStop, release } = yield* turns.start(
        conversationId,
        ids.runId,
        bot.id,
        actor,
      );

      yield* store.ensure(conversationId, bot.id);

      const isNew = yield* store.append(conversationId, {
        id: message.messageId,
        role: "user",
        text: message.text,
      });

      if (!isNew) {
        return yield* new MessageAlreadySent({ messageId: message.messageId });
      }

      const history = yield* store.messages(conversationId);

      const written = yield* Ref.make<ReadonlyArray<Message>>([]);

      // Store the Bot's messages, then free the conversation. It runs just before the terminal
      // event, so a client that sees the run end can reload or send again at once. The finalizer
      // covers a turn cut off without one, such as a client that disconnected. `cached` makes the
      // two share a single run.
      const settle = yield* Effect.cached(
        Ref.get(written).pipe(
          Effect.flatMap((messages) =>
            Effect.forEach(
              messages.filter((reply) => reply.text.length > 0),
              (reply) => store.append(conversationId, reply),
              { discard: true },
            ),
          ),
          Effect.andThen(release),
        ),
      );

      yield* Effect.addFinalizer(() => settle);

      // A stop that landed during the awaits above has already completed the signal. Checking it
      // here keeps the model from speaking at all, where interruptWhen alone would let a first
      // delta through.
      const answer = Stream.unwrap(
        Deferred.isDone(stopped).pipe(
          Effect.map((isStopped) =>
            isStopped
              ? Stream.fromEffect(Deferred.await(stopped))
              : agent
                  .run({
                    bot: bot.id,
                    conversation: conversationId,
                    run: ids.runId,
                    instructions: turnInstructions(bot),
                    history,
                  })
                  .pipe(Stream.interruptWhen(Deferred.await(stopped))),
          ),
        ),
      ).pipe(
        // Here, where the stop becomes how the turn ends: a stop that lands once the Bot finished
        // records nothing.
        Stream.tapErrorTag("TurnStopped", recordStop),
      );

      // The stream runs in the turn's span, where Chat.send's own span has ended.
      return turnEvents(ids, answer).pipe(
        Stream.onStart(Effect.annotateCurrentSpan("actor.id", actorId(actor))),
        Stream.tap((event) => Ref.update(written, (messages) => recordText(messages, event))),
        Stream.mapEffect((event) =>
          isTerminal(event)
            ? settle.pipe(
                Effect.andThen(Effect.annotateCurrentSpan("chat.status", turnStatus(event))),
                Effect.as(event),
              )
            : Effect.succeed(event),
        ),
      );
    });

    const stop = Effect.fn("Chat.stop")(function* ({
      conversationId,
    }: typeof ConversationRef.Type) {
      yield* turns.stop(conversationId);
    });

    return ChatRpcs.of({
      "Chat.open": open,
      // A new root, so the trace is named after the turn rather than the socket or RPC call it came in on.
      "Chat.send": (message) =>
        Stream.unwrap(startTurn(message)).pipe(
          Stream.withSpan("Chat.turn", { root: true, attributes: { "chat.bot": message.botId } }),
        ),
      "Chat.stop": stop,
    });
  }),
);
