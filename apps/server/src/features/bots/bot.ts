import { type BotId, type BotSummary, ToolName, workspaceRoot } from "@aobot/domain";
import type { Option } from "effect";
import { untrustedGuidance } from "../../shared/untrusted.ts";

/** A Bot's role, as `bots.yaml` defines it: who it is, what it is told, and the tools it was granted. */
export interface Bot {
  readonly id: BotId;
  readonly name: string;
  /** The sidebar heading it is listed under. A Bot in none is listed right below the pinned ones. */
  readonly group: Option.Option<string>;
  readonly pinned: boolean;
  readonly instructions: string;
  readonly tools: ReadonlySet<ToolName>;
}

/** Whether `bot` may use `tool`. A tool a Bot was not granted is refused before any rule runs. */
export function isGranted(bot: Bot, tool: ToolName): boolean {
  return bot.tools.has(tool);
}

/** What a Bot is told about each tool, so it is told only about the ones it was granted. */
const toolGuidance = {
  navigate:
    "navigate opens a web page in your computer's browser and answers with the page read as text, with a ref per element.",
  snapshot: "snapshot reads the page open in your browser afresh, with a ref per element.",
  click:
    "click acts on an element by its ref. Every browser action answers with the page read afresh; use refs from the latest one.",
  type: "type puts text in a field by its ref, replacing what it held, and does not press Enter.",
  run: `run runs a bash command in ${workspaceRoot}, your own folder, where you create and read files.`,
  read_file: `read_file reads a file in ${workspaceRoot} by its path inside it, such as notes.txt. A file your person gives you lands there.`,
  write_file: `write_file saves a file in ${workspaceRoot}. Your person can download it from the chat, so save what they ask you to make that way.`,
  list_files: `list_files lists the files and folders in ${workspaceRoot}.`,
} satisfies { readonly [Name in ToolName]: string };

/** The paragraph about the tools `bot` was granted, in the toolkit's order. */
function toolParagraph(bot: Bot): string {
  const granted = ToolName.literals.filter((tool) => bot.tools.has(tool));

  if (granted.length === 0) {
    return "You have no tools: answer from what you know and from what your person tells you.";
  }

  return [
    `You have a computer, and these tools on it: ${granted.join(", ")}. Any other tool is refused, so do not try one.`,
    ...granted.map((tool) => toolGuidance[tool]),
  ].join("\n");
}

/** What the model is told at the start of each of `bot`'s turns. */
export function turnInstructions(bot: Bot): string {
  return [bot.instructions.trim(), toolParagraph(bot), untrustedGuidance].join("\n");
}

/** What the page shows about a Bot. */
export function botSummary(bot: Bot): BotSummary {
  return { id: bot.id, name: bot.name };
}
