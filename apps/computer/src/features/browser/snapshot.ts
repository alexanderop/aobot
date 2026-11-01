import { keepFirst } from "@aobot/domain";

/** A page's snapshot as the Bot receives it: at most the limit, and whether anything was cut. */
export interface CappedSnapshot {
  readonly snapshot: string;
  readonly truncated: boolean;
}

/** Cut `text` to at most `limit` UTF-16 code units, never splitting a surrogate pair. */
export function capSnapshot(text: string, limit: number): CappedSnapshot {
  if (text.length <= limit) return { snapshot: text, truncated: false };

  return { snapshot: keepFirst(text, limit), truncated: true };
}
