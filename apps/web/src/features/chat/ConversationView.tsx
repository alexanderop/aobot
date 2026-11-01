import { Option } from "effect";
import { useEffect, useRef } from "react";
import type { ConversationId } from "@aobot/domain";
import { Bubble } from "./Bubble.tsx";
import { Composer } from "./Composer.tsx";
import { TranscriptItem } from "./conversation-state.ts";
import { ToolCallCard } from "./ToolCallCard.tsx";
import "./chat.css";
import { useConversation } from "./use-conversation.ts";

/** One conversation with a Bot: the name pill, the transcript, and the composer. */
export function ConversationView(props: { readonly conversationId: ConversationId }) {
  const { bot, transcript, isRunning, error, send, stop } = useConversation(props.conversationId);
  const botName = Option.match(bot, { onNone: () => "Bot", onSome: (summary) => summary.name });
  const bottom = useRef<HTMLDivElement>(null);
  const last = transcript.at(-1);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [transcript.length, last]);

  return (
    <main className="conversation">
      <header className="conversation__header">
        <span className="pill">
          <span className="pill__dot" />
          {Option.isSome(bot) ? botName : "Connecting…"}
        </span>
      </header>
      <div className="conversation__messages" role="log" aria-live="polite" aria-busy={isRunning}>
        {transcript.map(
          TranscriptItem.$match({
            Message: (message) => <Bubble key={`message-${message.id}`} message={message} />,
            ToolCall: (call) => <ToolCallCard key={`tool-${call.id}`} call={call} />,
          }),
        )}
        <div ref={bottom} />
      </div>
      {Option.match(error, {
        onNone: () => null,
        onSome: (problem) => (
          <p className="conversation__error" role="alert" data-code={problem.code}>
            {problem.message}
          </p>
        ),
      })}
      <Composer
        botName={botName}
        disabled={Option.isNone(bot)}
        isRunning={isRunning}
        onSend={send}
        onStop={stop}
      />
    </main>
  );
}
