import { Option } from "effect";
import { useEffect, useRef } from "react";
import { Bubble } from "./Bubble.tsx";
import { Composer } from "./Composer.tsx";
import "./chat.css";
import type { UseConversation } from "./use-conversation.ts";

/**
One conversation with a Bot: the name pill, the messages, and the composer. It draws what it is given
and reads no atoms, so the app feeds it from `useConversation` and the docs feed it scripted values.
*/
export function ConversationPanel(props: { readonly conversation: UseConversation }) {
  const { bot, messages, isRunning, error, send, stop } = props.conversation;
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
      <div className="conversation__messages" role="log" aria-live="polite" aria-busy={isRunning}>
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
