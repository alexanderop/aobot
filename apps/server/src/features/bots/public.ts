import { BotId, type BotSummary } from "@aobot/domain";
import { Toolkit } from "effect/ai";

/** A Bot's role: who it is and what it is told. Its tools arrive with the gateway (E1). */
export interface Bot {
  readonly id: BotId;
  readonly name: string;
  readonly instructions: string;
}

/** The one Bot E0-1 knows. More Bots arrive with E2-1. */
export const assistant: Bot = {
  id: BotId.make("assistant"),
  name: "Assistant",
  instructions:
    "You are Assistant, a helpful coworker. Answer briefly and plainly. If you do not know, say so.",
};

/** The tools every Bot may be offered. Empty until the gateway exists. */
export const botToolkit = Toolkit.empty;

/** What the page shows about a Bot. */
export function botSummary(bot: Bot): BotSummary {
  return { id: bot.id, name: bot.name };
}
