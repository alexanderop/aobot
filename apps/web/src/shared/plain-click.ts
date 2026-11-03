import type { MouseEvent } from "react";

/** A click the page handles itself; one with a modifier or another button opens the link as usual. */
export function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
