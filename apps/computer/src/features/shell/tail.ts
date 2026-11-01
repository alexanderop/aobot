import { type CommandOutput, keepLast } from "@aobot/domain";

/**
Collects the last `limit` code units of text that arrives in pieces. It is cut back while the text
arrives, not once it has all come, so `yes` or `cat` of a large file never holds more than twice the
limit in memory, and the cut is remembered so the end does not pass for all of it.
*/
export function outputTail(limit: number) {
  let text = "";
  let truncated = false;

  return {
    add(piece: string): void {
      text += piece;

      if (text.length <= 2 * limit) return;
      text = keepLast(text, limit);
      truncated = true;
    },
    read(): CommandOutput {
      if (text.length <= limit) return { text, truncated };

      return { text: keepLast(text, limit), truncated: true };
    },
  };
}
