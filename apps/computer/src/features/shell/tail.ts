import { keepLast } from "@aobot/domain";

/** The end of a stream of text, and whether anything before it was dropped. */
export interface Tail {
  readonly text: string;
  readonly truncated: boolean;
}

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
    read(): Tail {
      if (text.length <= limit) return { text, truncated };

      return { text: keepLast(text, limit), truncated: true };
    },
  };
}
