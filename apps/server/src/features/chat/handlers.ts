import {
  ChatRpcs,
  ConversationBusy,
  type ConversationId,
  type ConversationRef,
  MessageId,
  RunId,
  type SendMessage,
} from "@aobot/domain";
import { Deferred, Effect, MutableHashMap, Option, Ref, Stream } from "effect";
import { AgentEvent, AgentRuntime } from "../agent/public.ts";
import { assistant, botSummary } from "../bots/public.ts";
import { ConversationStore } from "./conversation-store.ts";
import { TurnStopped, isTerminal, turnEvents } from "./turn.ts";

/** The chat API: open a conversation, send a message and watch the answer stream, stop a turn. */
export const chatHandlersLayer = ChatRpcs.toLayer(
  Effect.gen(function* () {
    const store = yield* ConversationStore;
    const agent = yield* AgentRuntime;

    // One server process owns every run, so this map is the whole "one run per conversation" rule:
    // an entry exists exactly while a turn runs, and a restart starts with none. Its value is that
    // turn's stop signal.
    const runs = MutableHashMap.empty<ConversationId, Deferred.Deferred<void>>();

    const open = Effect.fn("Chat.open")(function* ({
      conversationId,
    }: typeof ConversationRef.Type) {
      const messages = yield* store.messages(conversationId);

      return {
        bot: botSummary(assistant),
        messages,
        isRunning: MutableHashMap.has(runs, conversationId),
      };
    });

    const startTurn = Effect.fn("Chat.send")(function* (message: typeof SendMessage.Type) {
      const { conversationId } = message;

      const ids = {
        conversationId,
        runId: RunId.make(crypto.randomUUID()),
        messageId: MessageId.make(crypto.randomUUID()),
      };

      const stopped = yield* Deferred.make<void>();

      // Removes this turn's entry only. By the time a finalizer calls it again, the next turn may
      // already hold the slot.
      const release = Effect.sync(() => {
        const held = MutableHashMap.get(runs, conversationId);

        if (Option.exists(held, (signal) => signal === stopped)) {
          MutableHashMap.remove(runs, conversationId);
        }
      });

      // The check and the insert run in one synchronous step, so two sends cannot both pass it.
      yield* Effect.acquireRelease(
        Effect.suspend(() =>
          MutableHashMap.has(runs, conversationId)
            ? Effect.fail(new ConversationBusy({ conversationId }))
            : Effect.sync(() => MutableHashMap.set(runs, conversationId, stopped)),
        ),
        () => release,
      );

      yield* store.ensure(conversationId, assistant.id);

      yield* store.append(conversationId, {
        id: message.messageId,
        role: "user",
        text: message.text,
      });

      const history = yield* store.messages(conversationId);

      const written = yield* Ref.make("");

      // Store the reply, then free the conversation. It runs just before the terminal event, so a
      // client that sees the run end can reload or send again at once. The finalizer covers a turn
      // cut off without one, such as a client that disconnected. `cached` makes the two share a
      // single run.
      const settle = yield* Effect.cached(
        Ref.get(written).pipe(
          Effect.flatMap((text) =>
            text.length === 0
              ? Effect.void
              : store.append(conversationId, { id: ids.messageId, role: "assistant", text }),
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
              ? Stream.fail(new TurnStopped())
              : agent.run({ instructions: assistant.instructions, history }).pipe(
                  Stream.tap((event) =>
                    AgentEvent.$is("TextDelta")(event)
                      ? Ref.update(written, (text) => text + event.text)
                      : Effect.void,
                  ),
                  Stream.interruptWhen(
                    Effect.andThen(Deferred.await(stopped), Effect.fail(new TurnStopped())),
                  ),
                ),
          ),
        ),
      );

      return turnEvents(ids, answer).pipe(
        Stream.mapEffect((event) =>
          isTerminal(event) ? Effect.as(settle, event) : Effect.succeed(event),
        ),
      );
    });

    const stop = Effect.fn("Chat.stop")(function* ({
      conversationId,
    }: typeof ConversationRef.Type) {
      yield* Option.match(MutableHashMap.get(runs, conversationId), {
        onNone: () => Effect.void,
        onSome: (signal) => Deferred.succeed(signal, undefined),
      });
    });

    return ChatRpcs.of({
      "Chat.open": open,
      "Chat.send": (message) => Stream.unwrap(startTurn(message)),
      "Chat.stop": stop,
    });
  }),
);
