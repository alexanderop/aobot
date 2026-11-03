import { ConversationId, RunId } from "@aobot/domain";
import { Schema } from "effect";

/**
The turn a call is made in: its conversation, and its run, which starts with each message the person
writes. A question a rule puts to the person is shown in that conversation, and their no holds for that run.
*/
export const TurnRef = Schema.Struct({ conversation: ConversationId, run: RunId });

/** A decoded {@link TurnRef}. */
export type TurnRef = typeof TurnRef.Type;
