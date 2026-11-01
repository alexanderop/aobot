import type { Turn } from "../agent-runtime.ts";

const speaker = { user: "Person", assistant: "You" } as const;

/**
One turn as the text of a single `session/prompt`. Each turn starts a fresh CLI with no memory, so the
prompt carries the Bot's instructions and the whole conversation so far.
*/
export function turnPrompt(turn: Turn): string {
  const conversation = turn.history
    .map((message) => `${speaker[message.role]}: ${message.text}`)
    .join("\n\n");

  return [
    "<instructions>",
    turn.instructions,
    "</instructions>",
    "",
    "<conversation>",
    conversation,
    "</conversation>",
    "",
    "Answer the person's last message.",
  ].join("\n");
}
