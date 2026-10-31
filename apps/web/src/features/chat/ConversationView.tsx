import { Option } from "effect";
import { useEffect, useRef } from "react";
import type { ConversationId } from "@aobot/domain";
import { Bubble } from "./Bubble.tsx";
import { Composer } from "./Composer.tsx";
import "./chat.css";
import { useConversation } from "./use-conversation.ts";

/** One conversation with a Bot: the name pill, the messages, and the composer. */
export function ConversationView(props: { readonly conversationId: ConversationId }) {
  const { bot, messages, isRunning, error, send, stop } = useConversation(props.conversationId);
  const botName = Option.match(bot, { onNone: () => "Bot", onSome: (summary) => summary.name });
  const bottom = useRef<HTMLDivElement>(null);
  const lastText = messages.at(-1)?.text;

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages.length, lastText]);

  return (
    <main className="conversation">
      <header className="conversation__header">
        <span className="pill">
          <span className="pill__dot" />
          {Option.isSome(bot) ? botName : "Connecting…"}
        </span>
      </header>
      <div className="conversation__messages" role="log" aria-live="polite">
        {messages.map((message) => (
          <Bubble key={message.id} message={message} />
        ))}
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
