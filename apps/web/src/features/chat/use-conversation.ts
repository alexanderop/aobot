import { useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-react";
import { MessageId } from "@aobot/domain";
import type { BotSummary, ConversationId } from "@aobot/domain";
import { Option } from "effect";
import { useCallback } from "react";
import { conversation } from "./conversation.ts";
import { ConversationStatus, isRunning, usesComputer } from "./conversation-state.ts";
import type { FailureCode, TranscriptItem } from "./conversation-state.ts";

/** What went wrong with the last attempt, in words the person can read. */
interface ConversationError {
  readonly code: FailureCode;
  readonly message: string;
}

/** Everything a component needs from one conversation, as values and functions. */
export interface UseConversation {
  readonly bot: Option.Option<BotSummary>;
  /** Messages and tool calls, in the order they happened. */
  readonly transcript: ReadonlyArray<TranscriptItem>;
  readonly isRunning: boolean;
  /** Whether the Bot uses its computer this turn, as {@link usesComputer} decides. */
  readonly usesComputer: boolean;
  readonly error: Option.Option<ConversationError>;
  readonly send: (text: string) => void;
  readonly stop: () => void;
}

/** Open a conversation and follow it. Shaped like CopilotKit's `useAgent`: components read nothing else. */
export function useConversation(id: ConversationId): UseConversation {
  useAtomMount(conversation.open(id));

  const state = useAtomValue(conversation.state(id));
  const sendMessage = useAtomSet(conversation.send(id));
  const stopRun = useAtomSet(conversation.stop(id));
  const running = isRunning(state);
  const ready = Option.isSome(state.bot);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();

      if (trimmed === "" || running || !ready) return;
      sendMessage({ messageId: MessageId.make(crypto.randomUUID()), text: trimmed });
    },
    [running, ready, sendMessage],
  );

  const stop = useCallback(() => {
    if (running) stopRun();
  }, [running, stopRun]);

  return {
    bot: state.bot,
    transcript: state.transcript,
    isRunning: running,
    usesComputer: usesComputer(state),
    error: ConversationStatus.$match(state.status, {
      Idle: () => Option.none(),
      Running: () => Option.none(),
      Failed: ({ code, message }) => Option.some({ code, message }),
    }),
    send,
    stop,
  };
}
