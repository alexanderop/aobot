import { BotId, type BotSummary } from "@aobot/domain";
import { Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { ToolFailed } from "../../shared/tool-result.ts";
import { untrustedGuidance } from "../../shared/untrusted.ts";

/** A Bot's role: who it is and what it is told. */
export interface Bot {
  readonly id: BotId;
  readonly name: string;
  readonly instructions: string;
}

/** The one Bot E0-1 knows. More Bots arrive with E2-1. */
export const assistant: Bot = {
  id: BotId.make("assistant"),
  name: "Assistant",
  instructions: [
    "You are Assistant, a helpful coworker. Answer briefly and plainly. If you do not know, say so.",
    "You have a computer with a browser: navigate opens a page, snapshot reads the open page as text.",
    untrustedGuidance,
  ].join("\n"),
};

const navigate = Tool.make("navigate", {
  description:
    "Open a web page in your computer's browser. Answers with the page's address and title.",
  parameters: Schema.Struct({
    url: Schema.String.annotate({ description: "The page's http or https address." }),
  }),
  success: Schema.String,
  failure: ToolFailed,
  failureMode: "return",
});

const snapshot = Tool.make("snapshot", {
  description:
    "Read the page open in your computer's browser as text: its accessibility tree, with a ref for each element.",
  success: Schema.String,
  failure: ToolFailed,
  failureMode: "return",
});

/**
The tools every Bot is offered. Each is a gateway call: the gateway implements their handlers, and a
failure comes back as a result the model reads rather than ending the turn.
*/
export const botToolkit = Toolkit.make(navigate, snapshot);

/** What the page shows about a Bot. */
export function botSummary(bot: Bot): BotSummary {
  return { id: bot.id, name: bot.name };
}
