/** The end of a stream of text, and whether anything before it was dropped. */
export interface Tail {
  readonly text: string;
  readonly truncated: boolean;
}

/** The last `limit` code units of `text`. A cut that would split a surrogate pair starts after the pair instead. */
function lastCodeUnits(text: string, limit: number): string {
  const start = text.length - limit;
  const first = text.charCodeAt(start);
  const splitsPair = first >= 0xdc00 && first <= 0xdfff;

  return text.slice(splitsPair ? start + 1 : start);
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
      text = lastCodeUnits(text, limit);
      truncated = true;
    },
    read(): Tail {
      if (text.length <= limit) return { text, truncated };

      return { text: lastCodeUnits(text, limit), truncated: true };
    },
  };
}
