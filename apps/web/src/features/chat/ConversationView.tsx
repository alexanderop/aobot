import { Option } from "effect";
import { useEffect, useRef } from "react";
import type { BotId, ConversationId } from "@aobot/domain";
import { BotAvatar, type UsePause, usePause } from "../bots/public.ts";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { Bubble } from "./Bubble.tsx";
import { Composer } from "./Composer.tsx";
import { TranscriptItem } from "./conversation-state.ts";
import { ToolCallCard } from "./ToolCallCard.tsx";
import "./chat.css";
import { useAttachments } from "./use-attachments.ts";
import { useConversation, useReadWhenTurnEnds } from "./use-conversation.ts";

/** Pause, or Resume while the Bot is paused, once the server has said which it is. */
function PauseButton(props: { readonly pause: UsePause }) {
  const { paused, sending, pause, resume } = props.pause;

  return Option.match(paused, {
    onNone: () => null,
    onSome: (isPaused) => (
      <button
        type="button"
        className={isPaused ? "pause-button pause-button--resume" : "pause-button"}
        aria-disabled={sending}
        onClick={() => {
          if (sending) return;

          (isPaused ? resume : pause)();
        }}
      >
        {isPaused ? "Resume" : "Pause"}
      </button>
    ),
  });
}

/**
One conversation with a Bot: the pill with its avatar and name, Paused when it is, and the button that
pauses or resumes it; the transcript with the question the Bot waits on below it, and the composer.
*/
export function ConversationView(props: {
  readonly conversationId: ConversationId;
  readonly botId: BotId;
}) {
  const { bot, transcript, isRunning, turn, error, unsent, send, stop } = useConversation(
    props.conversationId,
    props.botId,
  );

  useReadWhenTurnEnds(props.conversationId, isRunning);

  const files = useAttachments(props.conversationId, send);
  const pause = usePause(props.botId);
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
                {Option.getOrElse(pause.paused, () => false) ? (
                  <span className="pill__badge">Paused</span>
                ) : null}
              </>
            ),
          })}
        </span>
        <PauseButton pause={pause} />
      </header>
      {Option.match(pause.problem, {
        onNone: () => null,
        onSome: (why) => (
          <p className="conversation__pause-problem" role="alert">
            {why}
          </p>
        ),
      })}
      <div className="conversation__messages" role="log" aria-live="polite" aria-busy={isRunning}>
        {transcript.map(
          TranscriptItem.$match({
            Message: (message) => <Bubble key={`message-${message.id}`} message={message} />,
            ToolCall: (call) => (
              <ToolCallCard key={`tool-${call.id}`} call={call} bot={props.botId} />
            ),
          }),
        )}
        <ApprovalCard conversationId={props.conversationId} turn={turn} />
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
