import { useAtomValue } from "@effect/atom-react";
import type { SessionState } from "@aobot/domain";
import type { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { session } from "../../shared/session.ts";

/** Who the page is open for, once the server has said. */
export function useSession(): Option.Option<SessionState> {
  return AsyncResult.value(useAtomValue(session));
}
