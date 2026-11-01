import { fileURLToPath } from "node:url";
import { MessageId } from "@aobot/domain";
import type { Turn } from "../agent-runtime.ts";

/**
The turns the agent contract suite runs and records, and the replay tests play back. Both sides import
them from here, so a recording always replays the turn it was made from.
*/
const scenarios = ["streams", "cancel", "escape"] as const;

/** One of {@link scenarios}. */
export type Scenario = (typeof scenarios)[number];

/** The one turn every scenario sends. */
export const contractTurn: Turn = {
  instructions: "Answer briefly.",
  history: [{ id: MessageId.make("message-1"), role: "user", text: "Say hi" }],
};

/** Where the recording of `scenario` on `agent` lives. */
export function transcriptFile(scenario: Scenario, agent: string): string {
  return fileURLToPath(new URL(`../acp/fixtures/${scenario}/${agent}.ndjson`, import.meta.url));
}
