import { useAtom, useAtomValue } from "@effect/atom-react";
import type { BotId } from "@aobot/domain";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";
import { lastChange, pausedBots } from "./pauses.ts";

/** Whether a Bot is paused, and what an admin can do about it. */
export interface UsePause {
  /** Whether the Bot is paused, once the server has said. */
  readonly paused: Option.Option<boolean>;
  /** Whether the last pause or resume is still on its way. */
  readonly sending: boolean;
  /** Why the last pause or resume did not happen. */
  readonly problem: Option.Option<string>;
  readonly pause: () => void;
  readonly resume: () => void;
}

/** The Bots paused now, none until the server has said. */
export function usePausedBots(): ReadonlyArray<BotId> {
  return Option.getOrElse(AsyncResult.value(useAtomValue(pausedBots)), () => []);
}

/** Follow whether `bot` is paused while the calling component is mounted. */
export function usePause(bot: BotId): UsePause {
  const paused = AsyncResult.value(useAtomValue(pausedBots));
  const [last, change] = useAtom(lastChange(bot));

  return {
    paused: Option.map(paused, (bots) => bots.includes(bot)),
    sending: last.waiting,
    problem: last.waiting ? Option.none() : Option.flatten(AsyncResult.value(last)),
    pause: useCallback(() => change("pause"), [change]),
    resume: useCallback(() => change("resume"), [change]),
  };
}
