import { Option } from "effect";
import { useEffect, useRef } from "react";
import type { BotId, ConversationId } from "@aobot/domain";
import { BotAvatar } from "../bots/public.ts";
import { Bubble } from "./Bubble.tsx";
import { Composer } from "./Composer.tsx";
import { TranscriptItem } from "./conversation-state.ts";
import { ToolCallCard } from "./ToolCallCard.tsx";
import "./chat.css";
import { useAttachments } from "./use-attachments.ts";
import { useConversation } from "./use-conversation.ts";

/** One conversation with a Bot: the pill with its avatar and name, the transcript, and the composer. */
export function ConversationView(props: {
  readonly conversationId: ConversationId;
  readonly botId: BotId;
}) {
  const { bot, transcript, isRunning, error, unsent, send, stop } = useConversation(
    props.conversationId,
    props.botId,
  );

  const files = useAttachments(props.conversationId, send);
  const bottom = useRef<HTMLDivElement>(null);
  const last = transcript.at(-1);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [transcript.length, last]);

  return (
    <main className="conversation">
      <header className="conversation__header">
        <span className="pill">
          {Option.match(bot, {
            onNone: () => (
              <>
                <span
                  className={Option.isSome(error) ? "pill__dot pill__dot--failed" : "pill__dot"}
                />
                {Option.isSome(error) ? "Unavailable" : "Connecting…"}
              </>
            ),
            onSome: (summary) => (
              <>
                <BotAvatar bot={summary.id} size={22} />
                {summary.name}
              </>
            ),
          })}
        </span>
      </header>
      <div className="conversation__messages" role="log" aria-live="polite" aria-busy={isRunning}>
        {transcript.map(
          TranscriptItem.$match({
            Message: (message) => <Bubble key={`message-${message.id}`} message={message} />,
            ToolCall: (call) => (
              <ToolCallCard key={`tool-${call.id}`} call={call} bot={props.botId} />
            ),
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
        // A message the server turned away starts a new draft holding its text.
        key={Option.match(unsent, { onNone: () => "draft", onSome: ({ id }) => id })}
        initialDraft={Option.match(unsent, { onNone: () => "", onSome: ({ text }) => text })}
        botName={Option.map(bot, (summary) => summary.name)}
        isRunning={isRunning}
        attachments={files.attachments}
        onAttach={files.attach}
        onDismiss={files.dismiss}
        onSend={files.send}
        onStop={stop}
      />
    </main>
  );
}
