import { BotId, MessageId } from "@aobot/domain";
import type { BotSummary, Message } from "@aobot/domain";
import type { UseConversation } from "@aobot/web";
import { Option } from "effect";

/** A conversation as `useConversation` would return it, with nothing happening: no Bot yet, no messages, no run. */
const quiet: UseConversation = {
  bot: Option.none(),
  messages: [],
  isRunning: false,
  error: Option.none(),
  send: () => undefined,
  stop: () => undefined,
};

/** The Bot every built screen talks to. */
const fitnessCoach: BotSummary = { id: BotId.make("fitness-coach"), name: "Fitness Coach" };

function say(id: string, role: Message["role"], text: string): Message {
  return { id: MessageId.make(id), role, text };
}

/** What the person asked. */
export const asked: readonly Message[] = [
  say("m1", "user", "Can you move tomorrow's workout to 7am?"),
];

/** Your message, then the Bot's answer as two bubbles and a third with line breaks. */
export const talk: readonly Message[] = [
  ...asked,
  say("m2", "assistant", "Done. Your calendar was free at 7:00."),
  say("m3", "assistant", "Here is the week now, so you can check it."),
  say(
    "m4",
    "assistant",
    "Mon  Push day, 18:00\nWed  Pull day, 18:00\nThu  Legs, 07:00\nSat  Long run, 09:30",
  ),
];

/** The Bot half way through a reply. */
export const halfAnswered: readonly Message[] = [
  ...asked,
  say("m2", "assistant", "Let me look at your calendar for tomorrow, then I'll"),
];

/** A conversation that is open and idle. */
export function connected(messages: readonly Message[]): UseConversation {
  return { ...quiet, bot: Option.some(fitnessCoach), messages };
}

/** A conversation that is open and failed with the last attempt. */
export function failed(
  messages: readonly Message[],
  code: "connection" | "busy" | "stalled",
  message: string,
): UseConversation {
  return { ...connected(messages), error: Option.some({ code, message }) };
}

/** A conversation whose Bot is still typing: the stop button shows in the composer. */
export function answering(messages: readonly Message[]): UseConversation {
  return { ...connected(messages), isRunning: true };
}

/** A conversation the page has not heard back from yet: the header says "Connecting…" and the composer is off. */
export const connecting: UseConversation = quiet;
