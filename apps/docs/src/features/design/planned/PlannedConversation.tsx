import { Bubble, Composer } from "@aobot/web";
import { MessageId } from "@aobot/domain";
import type { Message } from "@aobot/domain";
import { Avatar, characters } from "./Avatar.tsx";
import { ApprovalCard } from "./ApprovalCard.tsx";
import "./planned.css";

function say(id: string, role: Message["role"], text: string): Message {
  return { id: MessageId.make(id), role, text };
}

const before: readonly Message[] = [
  say("p1", "user", "Can you move tomorrow's workout to 7am?"),
  say("p2", "assistant", "Done. Your calendar was free at 7:00."),
  say("p3", "assistant", "That leaves the 18:00 slot empty."),
];

/**
Planned in E2-5: the conversation with a Bot asking before it acts. The header with the Bot's face and the
time, and the card, are not built yet. The bubbles and the composer are the app's own.
*/
export function PlannedConversation() {
  return (
    <main className="conversation">
      <header className="conversation__header conversation__header--stacked">
        <span className="pill">
          <Avatar character={characters.coral} size={26} />
          Fitness Coach
        </span>
        <time className="conversation__time">today 3:14 PM</time>
      </header>
      <div className="conversation__messages" role="log">
        {before.map((message) => (
          <Bubble key={message.id} message={message} />
        ))}
        <ApprovalCard
          question="Shall I delete the 18:00 slot?"
          answers={[
            { key: "A", label: "Yes, update the calendar" },
            { key: "B", label: "No, keep it" },
          ]}
        />
      </div>
      <Composer
        botName="Fitness Coach"
        disabled={false}
        isRunning={false}
        onSend={() => undefined}
        onStop={() => undefined}
      />
    </main>
  );
}
