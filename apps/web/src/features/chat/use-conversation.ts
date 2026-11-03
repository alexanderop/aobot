import { useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-react";
import { MessageId } from "@aobot/domain";
import type { BotId, BotSummary, ConversationId } from "@aobot/domain";
import { Option } from "effect";
import { useCallback, useMemo } from "react";
import { conversation } from "./conversation.ts";
import { ConversationStatus, isRunning, runningTurn, usesComputer } from "./conversation-state.ts";
import type { FailureCode, TranscriptItem, Unsent } from "./conversation-state.ts";

/** What went wrong with the last attempt, in words the person can read. */
interface ConversationError {
  readonly code: FailureCode;
  readonly message: string;
}

/** Everything a component needs from one conversation, as values and functions. */
export interface UseConversation {
  /** The conversation's own Bot, once the server said which. */
  readonly bot: Option.Option<BotSummary>;
  /** Messages and tool calls, in the order they happened. */
  readonly transcript: ReadonlyArray<TranscriptItem>;
  readonly isRunning: boolean;
  /** The person's message the turn in flight answers, which names it; none while nothing runs. */
  readonly turn: Option.Option<MessageId>;
  /** Whether the Bot uses its computer this turn, as {@link usesComputer} decides. */
  readonly usesComputer: boolean;
  readonly error: Option.Option<ConversationError>;
  /** The last message the server turned away, for the composer to offer again. */
  readonly unsent: Option.Option<Unsent>;
  /** Sends `text` as the person's next message. False when it could not go: empty, mid-run or not ready. */
  readonly send: (text: string) => boolean;
  readonly stop: () => void;
}

/**
Open a conversation with the Bot the page picked and follow it. Shaped like CopilotKit's `useAgent`:
components read nothing else. A conversation that has messages opens only with its own Bot.
*/
export function useConversation(id: ConversationId, botId: BotId): UseConversation {
  useAtomMount(conversation.open({ conversationId: id, botId }));

  const state = useAtomValue(conversation.state(id));
  const sendMessage = useAtomSet(conversation.send(id));
  const stopRun = useAtomSet(conversation.stop(id));
  const running = isRunning(state);
  const turn = useMemo(() => runningTurn(state), [state]);
  const ready = Option.isSome(state.bot);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();

      if (trimmed === "" || running || !ready) return false;
      sendMessage({ botId, messageId: MessageId.make(crypto.randomUUID()), text: trimmed });

      return true;
    },
    [running, ready, sendMessage, botId],
  );

  const stop = useCallback(() => {
    if (running) stopRun();
  }, [running, stopRun]);

  return {
    bot: state.bot,
    transcript: state.transcript,
    isRunning: running,
    turn,
    usesComputer: usesComputer(state),
    error: ConversationStatus.$match(state.status, {
      Idle: () => Option.none(),
      Running: () => Option.none(),
      Failed: ({ code, message }) => Option.some({ code, message }),
    }),
    unsent: state.unsent,
    send,
    stop,
  };
}
