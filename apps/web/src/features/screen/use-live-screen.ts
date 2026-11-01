import { useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { liveScreen } from "./live-screen.ts";

/** What a component reads of the Bot's screen. */
export interface UseLiveScreen {
  /** The screen as an image src, or none while it is blank or has not arrived. */
  readonly frame: Option.Option<string>;
}

/** Watch the Bot's screen while the calling component is mounted. */
export function useLiveScreen(): UseLiveScreen {
  return { frame: Option.flatten(AsyncResult.value(useAtomValue(liveScreen))) };
}
