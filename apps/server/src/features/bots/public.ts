import { BotId, type BotSummary, commandTimeLimitMs } from "@aobot/domain";
import { Duration, Schema } from "effect";
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
    "You have a computer with a browser: navigate opens a page, snapshot reads the open page as text with a ref per element, click and type act on an element by its ref. Every action answers with the page read afresh; use refs from the latest one.",
    "Your computer also has a shell: run runs a bash command in /workspace, your own folder, where you create and read files.",
    untrustedGuidance,
  ].join("\n"),
};

const navigate = Tool.make("navigate", {
  description:
    "Open a web page in your computer's browser. Answers with the page's address, title and text, with a ref for each element.",
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

const ref = Schema.String.annotate({
  description: "The element's ref, such as e12, from the latest page you were shown.",
});

const click = Tool.make("click", {
  description:
    "Click an element of the page open in your computer's browser. Answers with the page read afresh.",
  parameters: Schema.Struct({ ref }),
  success: Schema.String,
  failure: ToolFailed,
  failureMode: "return",
});

const type = Tool.make("type", {
  description:
    "Put text in a field of the page open in your computer's browser, replacing what it held. Does not press Enter, so nothing is submitted. Answers with the page read afresh.",
  parameters: Schema.Struct({
    ref,
    text: Schema.String.annotate({ description: "What the field should hold." }),
  }),
  success: Schema.String,
  failure: ToolFailed,
  failureMode: "return",
});

const run = Tool.make("run", {
  description: `Run a bash command in /workspace, your computer's own folder. It is stopped after ${Duration.format(Duration.millis(commandTimeLimitMs))}, with everything it started. Answers its exit code and the end of what it printed to stdout and stderr.`,
  parameters: Schema.Struct({
    command: Schema.String.annotate({
      description: "The command, as you would type it into bash, such as ls -la.",
    }),
  }),
  success: Schema.String,
  failure: ToolFailed,
  failureMode: "return",
});

/**
The tools every Bot is offered. Each is a gateway call: the gateway implements their handlers, and a
failure comes back as a result the model reads rather than ending the turn.
*/
export const botToolkit = Toolkit.make(navigate, snapshot, click, type, run);

/** What the page shows about a Bot. */
export function botSummary(bot: Bot): BotSummary {
  return { id: bot.id, name: bot.name };
}
