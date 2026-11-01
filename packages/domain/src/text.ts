const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** The first `limit` UTF-16 code units of `text`, one fewer when the cut would split a surrogate pair. */
export function keepFirst(text: string, limit: number): string {
  if (text.length <= limit) return text;

  return text.slice(0, isHighSurrogate(text.charCodeAt(limit - 1)) ? limit - 1 : limit);
}

/** The last `limit` UTF-16 code units of `text`, one fewer when the cut would split a surrogate pair. */
export function keepLast(text: string, limit: number): string {
  if (text.length <= limit) return text;

  const start = text.length - limit;

  return text.slice(isLowSurrogate(text.charCodeAt(start)) ? start + 1 : start);
}
