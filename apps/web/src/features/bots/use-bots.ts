import { useAtomValue } from "@effect/atom-react";
import type { BotSummary } from "@aobot/domain";
import type { Array, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { botList } from "./bots.ts";

/** The Bots the server knows, in the order `bots.yaml` lists them, once it has said. */
export function useBots(): Option.Option<Array.NonEmptyReadonlyArray<BotSummary>> {
  return AsyncResult.value(useAtomValue(botList));
}
