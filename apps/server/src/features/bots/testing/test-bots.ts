import { BotId, ToolName } from "@aobot/domain";
import { Option } from "effect";
import type { Bot } from "../bot.ts";
import { botsLayer } from "../bots.ts";

/** Granted every tool, like Assistant in `bots.yaml`. */
export const assistant: Bot = {
  id: BotId.make("assistant"),
  name: "Assistant",
  group: Option.none(),
  pinned: true,
  instructions: "You are Assistant.",
  tools: new Set(ToolName.literals),
};

/** Granted the browser's reading tools only, like Researcher in `bots.yaml`. */
export const researcher: Bot = {
  id: BotId.make("researcher"),
  name: "Researcher",
  group: Option.some("research"),
  pinned: false,
  instructions: "You are Researcher.",
  tools: new Set(["snapshot", "navigate", "click"]),
};

/** {@link assistant} and {@link researcher}. */
export const testBots = botsLayer([assistant, researcher]);
