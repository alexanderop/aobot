/** A page's snapshot as the Bot receives it: at most the limit, and whether anything was cut. */
export interface CappedSnapshot {
  readonly snapshot: string;
  readonly truncated: boolean;
}

/**
Cut `text` to at most `limit` UTF-16 code units. A cut that would split a surrogate pair stops before the
pair instead, so the result is always valid text.
*/
export function capSnapshot(text: string, limit: number): CappedSnapshot {
  if (text.length <= limit) return { snapshot: text, truncated: false };

  const last = text.charCodeAt(limit - 1);
  const splitsPair = last >= 0xd800 && last <= 0xdbff;

  return { snapshot: text.slice(0, splitsPair ? limit - 1 : limit), truncated: true };
}
