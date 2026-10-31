import {
  ChatRpcs,
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
import { holdLease, RunLease } from "./run-lease.ts";
import { TurnStopped, turnEvents } from "./turn.ts";

/** The chat API: open a conversation, send a message and watch the answer stream, stop a turn. */
export const chatHandlersLayer = ChatRpcs.toLayer(
  Effect.gen(function* () {
    const store = yield* ConversationStore;
    const lease = yield* RunLease;
    const agent = yield* AgentRuntime;

    // Stop reaches runs in this process only; the lease is what keeps other processes out.
    const stopSignals = MutableHashMap.empty<ConversationId, Deferred.Deferred<void>>();

    const open = Effect.fn("Chat.open")(function* ({
      conversationId,
    }: typeof ConversationRef.Type) {
      const [messages, isRunning] = yield* Effect.all(
        [store.messages(conversationId), lease.isHeld(conversationId)],
        { concurrency: 2 },
      );

      return { bot: botSummary(assistant), messages, isRunning };
    });

    const startTurn = Effect.fn("Chat.send")(function* (message: typeof SendMessage.Type) {
      const { conversationId } = message;

      const ids = {
        conversationId,
        runId: RunId.make(crypto.randomUUID()),
        messageId: MessageId.make(crypto.randomUUID()),
      };

      yield* store.ensure(conversationId, assistant.id);
      yield* holdLease(conversationId, ids.runId).pipe(Effect.provideService(RunLease, lease));
      yield* store.append(conversationId, {
        id: message.messageId,
        role: "user",
        text: message.text,
      });
      const history = yield* store.messages(conversationId);

      const stop = yield* Deferred.make<void>();

      yield* Effect.acquireRelease(
        Effect.sync(() => MutableHashMap.set(stopSignals, conversationId, stop)),
        () => Effect.sync(() => MutableHashMap.remove(stopSignals, conversationId)),
      );

      const written = yield* Ref.make("");

      yield* Effect.addFinalizer(() =>
        Effect.flatMap(Ref.get(written), (text) =>
          text.length === 0
            ? Effect.void
            : store.append(conversationId, { id: ids.messageId, role: "assistant", text }),
        ),
      );

      const answer = agent.run({ instructions: assistant.instructions, history }).pipe(
        Stream.tap((event) =>
          AgentEvent.$is("TextDelta")(event)
            ? Ref.update(written, (text) => text + event.text)
            : Effect.void,
        ),
        Stream.interruptWhen(Effect.andThen(Deferred.await(stop), Effect.fail(new TurnStopped()))),
      );

      return turnEvents(ids, answer);
    });

    const stop = Effect.fn("Chat.stop")(function* ({
      conversationId,
    }: typeof ConversationRef.Type) {
      yield* Option.match(MutableHashMap.get(stopSignals, conversationId), {
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
